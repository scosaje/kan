/**
 * Single source of truth for lane-agent workflow ids.
 *
 * Used by:
 *   - the supervisor CLI (when starting / listing / stopping agents)
 *   - the LaneAgentWorkflow itself (when filtering its own sweep)
 *   - the kan-temporal-bridge dispatch path (when fanning card.moved out)
 *
 * Lane names are user-supplied strings on the Kan board; we canonicalise to
 * uppercase + dash-joined so the workflow id is stable across leading/
 * trailing whitespace, mixed case, and inner whitespace runs. Anyone needing
 * to compute the id should call this function — never reproduce the regex.
 *
 * NOTE: a copy of this function lives at
 *   /home/sco/kaban-system/kan/services/temporal-bridge/src/temporal/agentIds.ts
 * Keep them in sync. (Cross-package imports are intentionally avoided so each
 * service can be deployed independently.)
 */
export function agentWorkflowId(
  boardPublicId: string,
  laneName: string,
): string {
  const canon = laneName.trim().toUpperCase().replace(/\s+/g, "-");
  return `lane-agent:${boardPublicId}:${canon}`;
}

/** Pattern for cardArrived signals fanned out by the bridge. */
export const CARD_ARRIVED_SIGNAL = "cardArrived";
