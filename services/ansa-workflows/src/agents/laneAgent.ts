/**
 * LaneAgentWorkflow — a generic, long-running, autonomous agent assigned to
 * one (board, lane) tuple. The agent watches cards entering its lane, applies
 * lane-specific rules (label gates, dwell SLA, auto-advance timers), and drives
 * cards forward via kan-board-ops activities.
 *
 * One LaneAgent per (board, lane). Workflow id pattern:
 *     lane-agent:{boardPublicId}:{LANE_NAME}
 *
 * The bridge fans out card.moved events as `cardArrived` signals to the agent
 * for the destination lane. Agents that opt to run as `advisor` mode only
 * comment; `executor` mode also moves cards.
 *
 * Long-running shape: the agent calls continueAsNew once it has handled
 * MAX_HANDOVERS cards or after MAX_LIFETIME_MS, keeping workflow history
 * bounded. State (in-flight cards) is preserved across handovers.
 */
import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  sleep,
  log as wfLog,
  continueAsNew,
} from "@temporalio/workflow";
import type { AgentConfig } from "./config.js";

type KanBoardOps = {
  getCard(cardPublicId: string): Promise<{
    publicId: string;
    title: string;
    description: string | null;
    list?: { publicId: string; name: string };
    labels?: { name: string }[];
  }>;
  getBoard(boardPublicId: string): Promise<{
    publicId: string;
    name: string;
    lists: {
      publicId: string;
      name: string;
      cards?: {
        publicId: string;
        labels?: { name: string }[];
      }[];
    }[];
  }>;
  postComment(cardPublicId: string, body: string): Promise<unknown>;
  moveCardToLane(cardPublicId: string, boardPublicId: string, laneName: string): Promise<string>;
};

const ops = proxyActivities<KanBoardOps>({
  taskQueue: "kan-board-ops",
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 4 },
});

interface CardState {
  publicId: string;
  arrivedAt: number; // workflow-time epoch ms
  greeted: boolean;
  slaWarned: boolean;
  resolved: boolean; // moved away / completed
}

export interface LaneAgentInput {
  boardPublicId: string;
  config: AgentConfig;
  /** Carried across continueAsNew so we don't lose live cards */
  inflight?: Record<string, CardState>;
}

export const cardArrivedSignal = defineSignal<[string]>("cardArrived");
export const cardLeftSignal = defineSignal<[string]>("cardLeft");
export const stopSignal = defineSignal<[]>("stop");

export const inflightQuery = defineQuery<CardState[]>("inflight");
export const configQuery = defineQuery<AgentConfig>("config");

const MAX_HANDOVERS = 200;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24h

function tpl(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));
}

function laneMatches(card: { list?: { name: string } }, lane: string): boolean {
  return (card.list?.name ?? "").trim().toUpperCase() === lane.trim().toUpperCase();
}

function labelSet(card: { labels?: { name: string }[] }): Set<string> {
  return new Set((card.labels ?? []).map((l) => l.name.toUpperCase()));
}

function ruleHits(
  rule: { any_label?: string[]; all_labels?: string[] } | undefined,
  labels: Set<string>,
): boolean {
  if (!rule) return false;
  if (rule.any_label && rule.any_label.some((l) => labels.has(l.toUpperCase()))) return true;
  if (rule.all_labels && rule.all_labels.every((l) => labels.has(l.toUpperCase()))) return true;
  return false;
}

export async function LaneAgentWorkflow(input: LaneAgentInput): Promise<void> {
  const { boardPublicId, config } = input;
  const inflight = new Map<string, CardState>(
    Object.entries(input.inflight ?? {}),
  );
  let stopRequested = false;
  let handovers = 0;
  const startedAt = Date.now();

  setHandler(cardArrivedSignal, (publicId) => {
    if (!inflight.has(publicId)) {
      inflight.set(publicId, {
        publicId,
        arrivedAt: Date.now(),
        greeted: false,
        slaWarned: false,
        resolved: false,
      });
      wfLog.info("cardArrived", { publicId, lane: config.lane });
    }
  });
  setHandler(cardLeftSignal, (publicId) => {
    const s = inflight.get(publicId);
    if (s) s.resolved = true;
  });
  setHandler(stopSignal, () => { stopRequested = true; });

  setHandler(inflightQuery, () => Array.from(inflight.values()));
  setHandler(configQuery, () => config);

  const slaMs = (config.sla_minutes ?? 0) * 60_000;
  const autoMs = (config.auto_advance?.after_minutes ?? 0) * 60_000;

  // ---- initial sweep ------------------------------------------------------
  // Pick up cards that are already sitting in this lane when the agent first
  // boots, instead of waiting for the next move event. Skipped on
  // continueAsNew (where inflight is preserved by the caller).
  //
  // Stagger across agents to avoid a thundering-herd of getBoard calls when
  // the supervisor starts all five at once — Kan's rate limiter (429s) trips
  // otherwise. Sleep 0..6 s based on a hash of the lane name so each agent
  // picks a different slot.
  if (Object.keys(input.inflight ?? {}).length === 0) {
    let h = 0;
    for (const ch of config.lane) h = (h * 31 + ch.charCodeAt(0)) | 0;
    const stagger = (Math.abs(h) % 6) * 1000;
    if (stagger > 0) await sleep(stagger);
    try {
      const board = await ops.getBoard(boardPublicId);
      const list = board.lists.find(
        (l) => l.name.trim().toUpperCase() === config.lane.trim().toUpperCase(),
      );
      const seeded = list?.cards ?? [];
      for (const c of seeded) {
        if (!inflight.has(c.publicId)) {
          inflight.set(c.publicId, {
            publicId: c.publicId,
            arrivedAt: Date.now(),
            greeted: true, // skip on_card_arrived for residents — they were already in the lane
            slaWarned: false,
            resolved: false,
          });
        }
      }
      wfLog.info("initial sweep", { lane: config.lane, seeded: seeded.length });
    } catch (e) {
      wfLog.warn("initial sweep failed (will rely on cardArrived signals)", {
        err: (e as Error).message,
      });
    }
  }

  while (!stopRequested) {
    // Snapshot — we mutate the map below
    for (const state of [...inflight.values()]) {
      if (state.resolved) {
        inflight.delete(state.publicId);
        handovers++;
        continue;
      }

      // --- on_card_arrived greeting (idempotent: greeted flag) ---
      if (!state.greeted && config.on_card_arrived?.comment) {
        try {
          await ops.postComment(
            state.publicId,
            tpl(config.on_card_arrived.comment, {
              sla_minutes: config.sla_minutes ?? 0,
              agent: config.agent,
            }),
          );
          state.greeted = true;
        } catch (e) {
          wfLog.warn("greeting failed", { err: (e as Error).message });
        }
      }

      // --- pull current card state ---
      let card;
      try {
        card = await ops.getCard(state.publicId);
      } catch (e) {
        wfLog.warn("getCard failed; will retry next tick", { err: (e as Error).message });
        continue;
      }

      // If the card has already left this lane, drop it from inflight.
      if (!laneMatches(card, config.lane)) {
        wfLog.info("card moved away from lane", {
          publicId: state.publicId,
          newLane: card.list?.name,
        });
        inflight.delete(state.publicId);
        handovers++;
        continue;
      }

      const labels = labelSet(card);
      const dwellMs = Date.now() - state.arrivedAt;

      // If the card is opted into the per-card workflow (WORKFLOW label), the
      // agent yields — only the per-card KanCardWorkflow may execute moves to
      // avoid double-advance. We still post a [yielding] comment so the
      // timeline shows the agent observed the transition condition.
      const cardOwnedByPerCardWf = labels.has("WORKFLOW");
      const effectiveMode: "executor" | "advisor" =
        cardOwnedByPerCardWf ? "advisor" : config.mode;

      // --- abort path ---
      if (config.abort && ruleHits(config.abort, labels)) {
        if (effectiveMode === "executor") {
          if (config.abort.comment) {
            await ops.postComment(state.publicId, config.abort.comment);
          }
          await ops.moveCardToLane(state.publicId, boardPublicId, config.abort.to_lane);
        } else if (config.abort.comment) {
          const tag = cardOwnedByPerCardWf ? "[agent yielding to per-card workflow]" : "[advisor]";
          await ops.postComment(state.publicId, `${tag} ${config.abort.comment}`);
        }
        inflight.delete(state.publicId);
        handovers++;
        continue;
      }

      // --- advance path (label-gated) ---
      if (config.advance && ruleHits(config.advance, labels)) {
        if (effectiveMode === "executor") {
          if (config.advance.comment) {
            await ops.postComment(state.publicId, config.advance.comment);
          }
          await ops.moveCardToLane(state.publicId, boardPublicId, config.advance.to_lane);
        } else if (config.advance.comment) {
          const tag = cardOwnedByPerCardWf ? "[agent yielding to per-card workflow]" : "[advisor]";
          await ops.postComment(state.publicId, `${tag} ${config.advance.comment}`);
        }
        inflight.delete(state.publicId);
        handovers++;
        continue;
      }

      // --- auto-advance (dwell timer) ---
      if (config.auto_advance && dwellMs >= autoMs) {
        if (effectiveMode === "executor") {
          if (config.auto_advance.comment) {
            await ops.postComment(state.publicId, config.auto_advance.comment);
          }
          await ops.moveCardToLane(state.publicId, boardPublicId, config.auto_advance.to_lane);
        } else if (config.auto_advance.comment) {
          const tag = cardOwnedByPerCardWf ? "[agent yielding to per-card workflow]" : "[advisor]";
          await ops.postComment(state.publicId, `${tag} ${config.auto_advance.comment}`);
        }
        inflight.delete(state.publicId);
        handovers++;
        continue;
      }

      // --- SLA breach warning (post once) ---
      if (
        !state.slaWarned &&
        slaMs > 0 &&
        config.on_sla_breach?.comment &&
        dwellMs >= slaMs
      ) {
        await ops.postComment(
          state.publicId,
          tpl(config.on_sla_breach.comment, {
            sla_minutes: config.sla_minutes ?? 0,
            agent: config.agent,
          }),
        );
        state.slaWarned = true;
      }
    }

    // If the workflow has been running long enough OR has handed over enough
    // cards, recycle via continueAsNew to keep history bounded.
    if (handovers >= MAX_HANDOVERS || Date.now() - startedAt > MAX_LIFETIME_MS) {
      const nextInflight: Record<string, CardState> = {};
      for (const [k, v] of inflight) nextInflight[k] = v;
      wfLog.info("continueAsNew", { handovers, alive: inflight.size });
      await continueAsNew<typeof LaneAgentWorkflow>({
        boardPublicId,
        config,
        inflight: nextInflight,
      });
      return;
    }

    // Block until either a signal arrives OR the poll interval elapses.
    const tickMs = Math.max(5, config.poll_interval_seconds) * 1000;
    await Promise.race([
      sleep(tickMs),
      condition(() => stopRequested),
    ]);
  }
}
