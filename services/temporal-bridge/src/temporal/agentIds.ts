/**
 * Mirror of services/ansa-workflows/src/agents/ids.ts — kept in sync to avoid
 * cross-package imports across the bridge / ansa-workflows boundary.
 *
 * If you change one, change the other.
 */
export function agentWorkflowId(
  boardPublicId: string,
  laneName: string,
): string {
  const canon = laneName.trim().toUpperCase().replace(/\s+/g, "-");
  return `lane-agent:${boardPublicId}:${canon}`;
}

export const CARD_ARRIVED_SIGNAL = "cardArrived";
