import { Pool, PoolClient } from "pg";
import crypto from "node:crypto";
import { config } from "./config.js";
import { log } from "./log.js";
import { kan } from "./kanClient.js";

const WEBHOOK_NAME = "Temporal Bridge";
const WEBHOOK_EVENTS = ["card.created", "card.updated", "card.moved", "card.deleted"];
const WORKFLOW_LABEL_NAME = "WORKFLOW";
const WORKFLOW_LABEL_COLOUR = "#22d3ee";

// 12-char public id matching Kan's z.string().min(12) schema.
function newPublicId(): string {
  // 9 random bytes -> 12 chars in base64url, no padding, no slicing surprises
  return crypto.randomBytes(9).toString("base64url").slice(0, 12);
}

// Long-lived pool — we open one connection from it per bootstrap cycle and
// release on completion. Avoids the per-cycle connect/teardown churn.
const pool = new Pool({
  connectionString: config.POSTGRES_URL,
  max: 2,
  idleTimeoutMillis: 30_000,
});
pool.on("error", (err) => log.error({ err: err.message }, "pg pool error"));

// Single-flight: if a bootstrap is in-flight, queue the next caller behind it
// instead of spawning a parallel run. The 5-min interval can no longer overlap.
let inflight: Promise<void> | null = null;

export async function bootstrap(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const c = await pool.connect();
    try {
      const workspaces = await kan.listWorkspaces();
      if (!workspaces.length) {
        log.warn("No workspaces visible to bridge user — nothing to register");
        return;
      }
      for (const { workspace } of workspaces) {
        await ensureWebhook(c, workspace.publicId);
        const boards = await kan.listBoards(workspace.publicId);
        for (const b of boards) {
          await ensureWorkflowLabel(b.publicId, b.labels ?? []);
        }
      }
      log.info({ workspaces: workspaces.length }, "bootstrap complete");
    } finally {
      c.release();
    }
  })();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
}

export async function shutdown(): Promise<void> {
  await pool.end();
}

async function ensureWebhook(pg: PoolClient, workspacePublicId: string) {
  const ws = await pg.query<{ id: number }>(
    `SELECT id FROM workspace WHERE "publicId" = $1`,
    [workspacePublicId],
  );
  if (!ws.rowCount) return;
  const workspaceId = ws.rows[0]!.id;

  const user = await pg.query<{ id: string }>(
    `SELECT id FROM "user" WHERE email = $1 LIMIT 1`,
    [config.KAN_INTERNAL_EMAIL],
  );
  if (!user.rowCount) {
    log.warn({ email: config.KAN_INTERNAL_EMAIL }, "bot user missing — skip webhook");
    return;
  }
  const botUserId = user.rows[0]!.id;

  const url = `${config.BRIDGE_PUBLIC_URL}/events`;
  const events = JSON.stringify(WEBHOOK_EVENTS);

  const existing = await pg.query<{
    id: number;
    secret: string | null;
    events: string;
    active: boolean;
  }>(
    `SELECT id, secret, events, active
       FROM workspace_webhooks
      WHERE "workspaceId" = $1 AND url = $2`,
    [workspaceId, url],
  );

  if (existing.rowCount) {
    const row = existing.rows[0]!;
    const needsUpdate =
      row.secret !== config.BRIDGE_WEBHOOK_SECRET ||
      row.events !== events ||
      !row.active;
    if (!needsUpdate) {
      log.debug({ workspacePublicId, url }, "webhook already up-to-date");
      return;
    }
    await pg.query(
      `UPDATE workspace_webhooks
          SET secret = $1, events = $2, active = true, "updatedAt" = NOW()
        WHERE id = $3`,
      [config.BRIDGE_WEBHOOK_SECRET, events, row.id],
    );
    log.info({ workspacePublicId, url }, "webhook config updated");
    return;
  }

  await pg.query(
    `INSERT INTO workspace_webhooks
       ("publicId","workspaceId",name,url,secret,events,active,"createdBy","createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,true,$7,NOW())`,
    [
      newPublicId(),
      workspaceId,
      WEBHOOK_NAME,
      url,
      config.BRIDGE_WEBHOOK_SECRET,
      events,
      botUserId,
    ],
  );
  log.info({ workspacePublicId, url }, "webhook registered");
}

async function ensureWorkflowLabel(
  boardPublicId: string,
  existing: { name: string; publicId: string }[],
) {
  if (existing.some((l) => l.name?.toUpperCase() === WORKFLOW_LABEL_NAME)) return;
  try {
    await kan.createLabel(boardPublicId, WORKFLOW_LABEL_NAME, WORKFLOW_LABEL_COLOUR);
    log.info({ boardPublicId }, "WORKFLOW label created");
  } catch (e) {
    log.warn({ err: (e as Error).message, boardPublicId }, "could not create WORKFLOW label");
  }
}
