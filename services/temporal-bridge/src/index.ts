import express from "express";
import crypto from "node:crypto";
import {
  Connection,
  Client as TemporalClient,
  WorkflowNotFoundError,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { Worker, NativeConnection } from "@temporalio/worker";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { log } from "./log.js";
import { kan, type KanCard } from "./kanClient.js";
import { policyForBoard } from "./policy.js";
import { bootstrap, shutdown as shutdownPg } from "./registration.js";
import * as activities from "./temporal/activities.js";
import * as boardOps from "./temporal/board-ops.js";
import { agentWorkflowId, CARD_ARRIVED_SIGNAL } from "./temporal/agentIds.js";
import { laneArrivalLane, resolveFromLaneName } from "./lane-resolution.js";
import { handleMandateCardMove } from "./temporal/mandate-cards.js";
import {
  laneChangedSignal,
  labelAddedSignal,
  labelRemovedSignal,
  cardDeletedSignal,
  KanCardWorkflow,
  type KanCardWorkflowInput,
} from "./temporal/workflow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cardWorker: Worker | null = null;
let opsWorker: Worker | null = null;
const workerStates = { card: "init", ops: "init" };

// ---- Temporal workers (in-process) --------------------------------------
async function startWorkers() {
  const conn = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });

  cardWorker = await Worker.create({
    connection: conn,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    workflowsPath: path.resolve(__dirname, "./temporal/workflow.js"),
    activities,
  });
  log.info(
    { addr: config.TEMPORAL_ADDRESS, ns: config.TEMPORAL_NAMESPACE, queue: config.TEMPORAL_TASK_QUEUE },
    "Temporal worker starting (card workflow)",
  );
  cardWorker.run().then(
    () => { workerStates.card = "stopped"; },
    (e) => {
      workerStates.card = "crashed";
      log.error({ err: e, queue: config.TEMPORAL_TASK_QUEUE }, "card-worker crashed");
    },
  );
  workerStates.card = "running";

  opsWorker = await Worker.create({
    connection: conn,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_BOARD_OPS_QUEUE,
    activities: boardOps,
  });
  log.info(
    { queue: config.TEMPORAL_BOARD_OPS_QUEUE, ops: Object.keys(boardOps).length },
    "Temporal worker starting (board ops surface)",
  );
  opsWorker.run().then(
    () => { workerStates.ops = "stopped"; },
    (e) => {
      workerStates.ops = "crashed";
      log.error({ err: e, queue: config.TEMPORAL_BOARD_OPS_QUEUE }, "ops-worker crashed");
    },
  );
  workerStates.ops = "running";
}

// ---- Webhook receiver ----------------------------------------------------
type KanWebhookEvent =
  | "card.created"
  | "card.updated"
  | "card.moved"
  | "card.deleted";

interface KanLabelDiff {
  from: { name: string }[];
  to: { name: string }[];
}
interface KanWebhookChanges {
  labels?: KanLabelDiff;
  // other change shapes accepted but not consumed:
  [k: string]: { from: unknown; to: unknown } | undefined;
}
interface KanWebhookPayload {
  event: KanWebhookEvent;
  timestamp: string;
  data: {
    card: {
      id: string;
      publicId?: string;
      title: string;
      listId: string;
      boardId: string;
    };
    list?: { id: string; name: string };
    changes?: KanWebhookChanges;
  };
}

function verifySignature(raw: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", config.BRIDGE_WEBHOOK_SECRET)
    .update(raw)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const WORKFLOW_LABEL = "WORKFLOW";

// TTL cache of which lane-agent workflowIds exist (running). Entries live for
// AGENT_CACHE_TTL_MS; a `false` is also cached briefly to avoid hammering
// Temporal when no agent is running for that lane (the common case before the
// supervisor has been started).
const AGENT_CACHE_TTL_MS = 60_000;
const AGENT_CACHE_NEG_TTL_MS = 15_000;
const agentCache = new Map<string, { exists: boolean; expiresAt: number }>();

async function agentExists(
  temporal: TemporalClient,
  agentId: string,
): Promise<boolean> {
  const now = Date.now();
  const hit = agentCache.get(agentId);
  if (hit && hit.expiresAt > now) return hit.exists;
  let exists = false;
  try {
    const desc = await temporal.workflow.getHandle(agentId).describe();
    exists = desc.status.name === "RUNNING";
  } catch (e) {
    if (!(e instanceof WorkflowNotFoundError)) throw e;
    exists = false;
  }
  agentCache.set(agentId, {
    exists,
    expiresAt: now + (exists ? AGENT_CACHE_TTL_MS : AGENT_CACHE_NEG_TTL_MS),
  });
  return exists;
}

async function safeSignal(
  temporal: TemporalClient,
  wfId: string,
  reqId: string,
  fn: (handle: ReturnType<TemporalClient["workflow"]["getHandle"]>) => Promise<void>,
): Promise<boolean> {
  // Returns true if signal was delivered, false if workflow no longer exists.
  try {
    await fn(temporal.workflow.getHandle(wfId));
    return true;
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) {
      log.debug({ wfId, reqId }, "workflow not running — drop signal");
      return false;
    }
    throw e;
  }
}

async function dispatch(
  payload: KanWebhookPayload,
  temporal: TemporalClient,
  reqId: string,
) {
  // Upstream Kan (#490) sends both the internal id and the publicId; older
  // payloads only had `id`. Prefer publicId, fall back for compatibility.
  const cardPublicId = payload.data.card.publicId ?? payload.data.card.id;
  const boardPublicId = payload.data.card.boardId;

  if (typeof cardPublicId !== "string" || cardPublicId.length < 12) {
    log.debug({ event: payload.event, cardPublicId, reqId }, "skip non-public-id event");
    return;
  }
  const wfId = `kan-card:${cardPublicId}`;

  if (payload.event === "card.deleted") {
    await safeSignal(temporal, wfId, reqId, (h) => h.signal(cardDeletedSignal));
    log.info({ wfId, reqId }, "signalled card delete");
    return;
  }

  // MANDATE-owned cards are handled separately from the legacy
  // KanCardWorkflow / LaneAgent paths. The handler reads the card
  // description for the `mandate-meta` block; if present, it validates
  // the requested transition against operator_allowed_transitions and
  // signals the owning workflow with the mapped signal name. Cards
  // without the block fall through to the legacy logic below.
  if (payload.event === "card.moved" && payload.data.list?.name) {
    // Real Kan payloads carry the source list as a publicId in
    // changes.listId; resolving it to a lane name needs a board fetch.
    const fromLane = await resolveFromLaneName(
      payload.data.changes,
      boardPublicId,
      (id) => boardOps.getBoard(id),
    );
    const wasMandate = await handleMandateCardMove(
      {
        cardPublicId,
        boardPublicId,
        toLane: payload.data.list.name,
        fromLane,
        // Kan's webhook payload doesn't currently include actor
        // identity. The signalled `requested_by` falls back to
        // "kan-operator" inside handleMandateCardMove.
        requestedBy: undefined,
      },
      temporal,
    );
    if (wasMandate) {
      log.info(
        { cardPublicId, reqId },
        "mandate: card handled by MANDATE branch — skipping legacy paths",
      );
      return;
    }
  }

  let card: KanCard;
  try {
    card = await kan.getCard(cardPublicId);
  } catch (e) {
    log.warn({ err: (e as Error).message, cardPublicId, reqId }, "card fetch failed — skip");
    return;
  }
  const labelNames = (card.labels ?? []).map((l) => l.name.toUpperCase());
  const hasWorkflow = labelNames.includes(WORKFLOW_LABEL);
  const laneName = card.list?.name ?? "";

  // Fan out to a LaneAgent supervising the destination lane. This is the
  // autonomous-agent path — runs in addition to the per-card workflow signal
  // below. The agent watches all cards entering its lane (regardless of
  // WORKFLOW tag) and applies lane-level rules. Arrival = moved into the
  // lane OR created in it in-place (e.g. mandate nomination cards).
  const arrivalLane = laneArrivalLane(payload.event, payload.data.list);
  if (arrivalLane) {
    const agentId = agentWorkflowId(boardPublicId, arrivalLane);
    if (await agentExists(temporal, agentId)) {
      await safeSignal(temporal, agentId, reqId, (h) =>
        h.signal(CARD_ARRIVED_SIGNAL, cardPublicId),
      );
    } else {
      log.debug({ agentId, reqId }, "no lane agent — skipping fan-out");
    }
  }

  // Try to forward as a signal if a per-card workflow exists. TOCTOU-safe: the
  // helper catches WorkflowNotFoundError and returns false so we fall through
  // to the start path if appropriate.
  let signalled = false;
  if (payload.event === "card.moved" && payload.data.list?.name) {
    const lane = payload.data.list.name;
    signalled = await safeSignal(temporal, wfId, reqId, (h) =>
      h.signal(laneChangedSignal, lane),
    );
  } else if (payload.event === "card.updated" && payload.data.changes?.labels) {
    const before = new Set(
      (payload.data.changes.labels.from ?? []).map((l) => l.name.toUpperCase()),
    );
    const after = new Set(
      (payload.data.changes.labels.to ?? []).map((l) => l.name.toUpperCase()),
    );
    signalled = await safeSignal(temporal, wfId, reqId, async (h) => {
      for (const name of after) if (!before.has(name)) await h.signal(labelAddedSignal, name);
      for (const name of before) if (!after.has(name)) await h.signal(labelRemovedSignal, name);
    });
  }

  if (signalled) {
    log.info({ wfId, event: payload.event, reqId }, "signalled workflow");
    return;
  }

  // No running workflow. Only start one if the card opts in.
  if (!hasWorkflow) {
    log.debug({ cardPublicId, event: payload.event, reqId }, "card not WORKFLOW-tagged — ignoring");
    return;
  }

  const board = await kan.getBoard(boardPublicId);
  const policy = policyForBoard(board);
  if (!policy) {
    log.warn({ boardPublicId, reqId }, "no policy matches this board — cannot start workflow");
    return;
  }

  const input: KanCardWorkflowInput = {
    cardPublicId,
    boardPublicId,
    initialLane: laneName,
    initialLabels: labelNames,
    policy,
  };
  try {
    await temporal.workflow.start(KanCardWorkflow, {
      workflowId: wfId,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      args: [input],
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    });
    log.info({ wfId, lane: laneName, policy: policy.name, reqId }, "workflow started");
  } catch (e) {
    if (e instanceof WorkflowExecutionAlreadyStartedError) {
      // Two near-simultaneous webhook events raced to start the same workflow.
      // The first one won — re-route as a signal and we're done.
      log.info({ wfId, reqId }, "workflow already started by another event — re-routing as signal");
      if (payload.event === "card.moved" && payload.data.list?.name) {
        await safeSignal(temporal, wfId, reqId, (h) =>
          h.signal(laneChangedSignal, payload.data.list!.name),
        );
      }
      return;
    }
    throw e;
  }
}

let serverHandle: ReturnType<express.Express["listen"]> | null = null;

async function gracefulShutdown(reason: string) {
  log.info({ reason }, "shutting down");
  try {
    if (serverHandle) await new Promise<void>((r) => serverHandle!.close(() => r()));
    await Promise.allSettled([cardWorker?.shutdown(), opsWorker?.shutdown()]);
    await shutdownPg();
  } catch (e) {
    log.error({ err: (e as Error).message }, "shutdown error");
  } finally {
    process.exit(0);
  }
}

async function main() {
  const conn = await Connection.connect({ address: config.TEMPORAL_ADDRESS });
  const temporal = new TemporalClient({ connection: conn, namespace: config.TEMPORAL_NAMESPACE });

  await startWorkers();

  bootstrap().catch((e) => log.warn({ err: e.message }, "bootstrap failed (will retry)"));
  // bootstrap() is itself single-flight (see registration.ts); the interval is
  // a safety net for when workspaces are added or webhook config drifts.
  setInterval(() => bootstrap().catch(() => {}), 5 * 60_000);

  const app = express();
  app.use(express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: string }).rawBody = buf.toString("utf8");
    },
  }));
  // Per-request correlation id propagated to all log lines spawned by the
  // dispatch path. Lets ops trace a single Kan delivery through the bridge.
  app.use((req, _res, next) => {
    (req as unknown as { reqId: string }).reqId =
      req.header("x-request-id") ?? crypto.randomBytes(6).toString("hex");
    next();
  });

  app.get("/healthz", (_req, res) => {
    const lastLogin = kan.lastLoginEpochMs;
    const cardOk = workerStates.card === "running";
    const opsOk = workerStates.ops === "running";
    // Informational only — Better Auth sessions live 30 days and the bridge
    // only re-auths on 401, so a long-running healthy bridge legitimately
    // shows a "stale" lastLoginAt. We expose the value but don't gate `ok`
    // on it; failures surface via the 401-retry loop in KanClient.
    const loginOk = lastLogin != null;
    const ok = cardOk && opsOk;
    res.status(ok ? 200 : 503).json({
      ok,
      workers: { card: workerStates.card, ops: workerStates.ops },
      lastKanLoginAgoMs: lastLogin == null ? null : Date.now() - lastLogin,
      kanSessionFresh: loginOk,
      uptimeSec: Math.round(process.uptime()),
    });
  });

  app.post("/events", async (req, res) => {
    const reqId = (req as unknown as { reqId: string }).reqId;
    const raw = (req as unknown as { rawBody: string }).rawBody ?? "";
    const sig = req.header("x-kan-signature") ?? req.header("x-webhook-signature");
    if (!verifySignature(raw, sig?.replace(/^sha256=/, ""))) {
      log.warn({ sig, reqId }, "signature mismatch");
      return res.status(401).json({ error: "bad signature" });
    }
    const payload = req.body as KanWebhookPayload;
    res.json({ ok: true, reqId });
    dispatch(payload, temporal, reqId).catch((e) =>
      log.error({ err: e, reqId }, "dispatch failed"),
    );
  });

  serverHandle = app.listen(config.BRIDGE_PORT, () => {
    log.info({ port: config.BRIDGE_PORT }, "kan-temporal-bridge listening");
  });

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

main().catch((e) => {
  log.error({ err: e }, "fatal");
  process.exit(1);
});
