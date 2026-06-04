/**
 * MANDATE role bundle → Kan workspace role mapping (Phase 1 stub).
 *
 * Real OIDC wiring (MANDATE as IdP issuing Kan sessions) is a later phase; for
 * now this maps the four SAR MANDATE role bundles onto Kan's two workspace
 * roles so a synced operator lands with sensible permissions.
 */
export type KanWorkspaceRole = "member" | "admin";

export const MANDATE_TO_KAN: Record<string, KanWorkspaceRole> = {
  "Watch-Zone-Designator": "member",
  "Watch-Zone-Approver": "admin",
  "SAR-Tasking-Operator": "member",
  "Field-Team-Dispatcher": "admin",
};

/**
 * Resolve the highest-privilege Kan role for a set of MANDATE role bundles.
 * Unknown bundles are ignored; if any maps to `admin`, the result is `admin`,
 * otherwise `member` (or null if none of the bundles are SAR roles).
 */
export function mapMandateRolesToKan(
  roles: readonly string[],
): KanWorkspaceRole | null {
  let result: KanWorkspaceRole | null = null;
  for (const role of roles) {
    const mapped = MANDATE_TO_KAN[role];
    if (mapped === "admin") return "admin";
    if (mapped === "member") result = "member";
  }
  return result;
}
