import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  log as wfLog,
  CancellationScope,
  isCancellation,
} from "@temporalio/workflow";
import type * as activities from "./activities.js";
import type { Policy, LaneRules } from "../policy.js";

const { postComment, advanceCardToLane } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 4 },
});

export interface KanCardWorkflowInput {
  cardPublicId: string;
  boardPublicId: string;
  initialLane: string;
  initialLabels: string[];
  policy: Policy;
}

export const laneChangedSignal =
  defineSignal<[string]>("laneChanged");
export const labelAddedSignal =
  defineSignal<[string]>("labelAdded");
export const labelRemovedSignal =
  defineSignal<[string]>("labelRemoved");
export const cardDeletedSignal =
  defineSignal<[]>("cardDeleted");

/**
 * Generic, policy-driven workflow. One instance per opt-in card.
 *
 * Lifecycle:
 *   for each lane the card occupies:
 *     run lane.on_enter actions (e.g. comment)
 *     wait for any of:
 *       • a lane change signal      → recurse with new lane
 *       • a label that the rule wants → advance per on_label.advance_to
 *       • auto_advance_after_minutes elapses → move to next_lane
 *       • timeout_minutes elapses    → run on_timeout, keep waiting
 *     stop when lane.terminal is true or the card is deleted.
 */
export async function KanCardWorkflow(input: KanCardWorkflowInput): Promise<void> {
  let currentLane = input.initialLane;
  let lastEnteredLane: string | null = null;
  const labels = new Set(input.initialLabels.map((l) => l.toUpperCase()));
  let deleted = false;

  setHandler(laneChangedSignal, (next) => {
    wfLog.info("laneChanged signal", { next });
    currentLane = next;
  });
  setHandler(labelAddedSignal, (name) => {
    wfLog.info("labelAdded signal", { name });
    labels.add(name.toUpperCase());
  });
  setHandler(labelRemovedSignal, (name) => {
    labels.delete(name.toUpperCase());
  });
  setHandler(cardDeletedSignal, () => {
    deleted = true;
  });

  while (!deleted) {
    const rule = findRule(input.policy, currentLane);
    if (!rule) {
      wfLog.info("no rule for lane, blocking on next signal", { currentLane });
      const enteredAt = currentLane;
      await condition(() => deleted || currentLane !== enteredAt);
      continue;
    }

    // Run on_enter only the first time we observe this lane. Soft timeouts
    // keep the workflow looping inside the same lane; we must not re-emit the
    // entry comments on every loop iteration.
    if (lastEnteredLane !== currentLane) {
      for (const a of rule.on_enter ?? []) {
        if (a.kind === "comment") {
          await postComment(input.cardPublicId, a.body);
        }
      }
      lastEnteredLane = currentLane;
    }

    if (rule.terminal) {
      wfLog.info("terminal lane reached", { currentLane });
      return;
    }

    const enteredAt = currentLane;
    const wantLabel = rule.wait_for_label?.toUpperCase();

    // Single condition handles the three exit triggers (lane changed, label
    // arrived, deleted) plus an optional auto-advance timeout. Promise.race
    // over multiple condition() scopes is no longer needed.
    let autoAdvanced = false;
    const autoMins = rule.auto_advance_after_minutes;
    const wantsAutoAdvance = !!(autoMins && rule.next_lane);

    // Soft-timeout warning runs in its own cancellable scope so a long-lived
    // wait can post a single warning without blocking transition signals.
    let softTimeoutScope: CancellationScope | null = null;
    if (rule.timeout_minutes && rule.on_timeout) {
      const timeoutMins = rule.timeout_minutes;
      const onTimeout = rule.on_timeout;
      softTimeoutScope = new CancellationScope();
      softTimeoutScope
        .run(async () => {
          const satisfied = await condition(
            () => deleted || currentLane !== enteredAt || (!!wantLabel && labels.has(wantLabel)),
            `${timeoutMins} minutes`,
          );
          if (!satisfied && onTimeout.kind === "comment") {
            await postComment(input.cardPublicId, onTimeout.body);
          }
        })
        .catch((e) => {
          if (!isCancellation(e)) throw e;
        });
    }

    const exitTrigger = () =>
      deleted || currentLane !== enteredAt || (!!wantLabel && labels.has(wantLabel));
    if (wantsAutoAdvance) {
      const satisfied = await condition(exitTrigger, `${autoMins} minutes`);
      if (!satisfied) autoAdvanced = true;
    } else {
      await condition(exitTrigger);
    }

    // Cancel the soft-timeout scope so it doesn't leak past the transition.
    softTimeoutScope?.cancel();

    if (deleted) return;

    // Resolve transition
    if (currentLane === enteredAt && wantLabel && labels.has(wantLabel)) {
      const advance = rule.on_label?.advance_to ?? rule.next_lane;
      if (rule.on_label?.comment) {
        await postComment(input.cardPublicId, rule.on_label.comment);
      }
      if (advance) {
        await advanceCardToLane(input.cardPublicId, input.boardPublicId, advance);
        currentLane = advance;
      }
    } else if (currentLane === enteredAt && autoAdvanced && rule.next_lane) {
      await advanceCardToLane(input.cardPublicId, input.boardPublicId, rule.next_lane);
      currentLane = rule.next_lane;
    }
    // else: a real lane-change signal arrived — loop and process the new lane
  }
}

function findRule(policy: Policy, laneName: string): LaneRules | null {
  const want = laneName.trim().toUpperCase();
  for (const [k, v] of Object.entries(policy.lanes)) {
    if (k.trim().toUpperCase() === want) return v;
  }
  return null;
}
