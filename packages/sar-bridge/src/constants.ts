/**
 * SAR ↔ Kan bridge constants.
 *
 * The bridge represents SAR Temporal workflows as Kan cards and turns operator
 * card-moves back into Temporal signals. These tables are the contract between
 * the two systems.
 */

/** Logical board key → Kan board slug. */
export const SAR_BOARD_SLUGS = {
  watchZoneLifecycle: "wz-lifecycle",
  alertsTriage: "sar-alerts-triage",
  taskingQueue: "sar-tasking-queue",
  dispatchRequests: "sar-dispatch-requests",
  retrospectiveCases: "sar-retrospective-cases",
} as const;

export type SarBoardKey = keyof typeof SAR_BOARD_SLUGS;
export type SarBoardSlug = (typeof SAR_BOARD_SLUGS)[SarBoardKey];

/** Board definitions used by the idempotent bootstrap. Phase 1 only *requires*
 *  the Watch Zone Lifecycle board; the rest are created as empty scaffolding so
 *  the Phase 2 surfaces (alerts, dispatch, retrospective) have a home. */
export interface BoardDef {
  key: SarBoardKey;
  slug: SarBoardSlug;
  name: string;
  lists: string[];
  phase: 1 | 2;
}

export const BOARD_DEFS: BoardDef[] = [
  {
    key: "watchZoneLifecycle",
    slug: "wz-lifecycle",
    name: "Watch Zone Lifecycle",
    lists: ["Proposed", "Awaiting Approval", "Active", "Suspended", "Closed"],
    phase: 1,
  },
  {
    key: "taskingQueue",
    slug: "sar-tasking-queue",
    name: "SAR Tasking Queue",
    lists: ["Requested", "Ordered", "Collecting", "Completed", "Failed"],
    phase: 2,
  },
  {
    key: "alertsTriage",
    slug: "sar-alerts-triage",
    name: "SAR Alerts Triage",
    lists: ["New", "Investigating", "Confirmed", "Dismissed"],
    phase: 2,
  },
  {
    key: "dispatchRequests",
    slug: "sar-dispatch-requests",
    name: "SAR Dispatch Requests",
    lists: ["Requested", "Approved", "Denied", "Dispatched"],
    phase: 2,
  },
  {
    key: "retrospectiveCases",
    slug: "sar-retrospective-cases",
    name: "SAR Retrospective Cases",
    lists: ["Open", "Under Review", "Closed"],
    phase: 2,
  },
];

/**
 * Card-move → Temporal signal mapping, keyed by `boardSlug` then by the
 * *destination* list name. A move to a list not in the map is a no-op (operators
 * can shuffle cards freely; only these transitions carry workflow meaning).
 *
 * NOTE: the signal *names* here are the contract the owning Temporal workflow
 * must register a matching signal handler for. In Phase 1 the Watch Zone
 * lifecycle is primarily driven by MANDATE → Kafka events; this Kan surface is
 * an additional, operator-facing control path. Phase 2 boards are placeholders.
 */
export const SIGNAL_MAP: Record<string, Record<string, string>> = {
  "wz-lifecycle": {
    Active: "wz.approved",
    Suspended: "wz.suspended",
    Closed: "wz.revoked",
  },
  "sar-dispatch-requests": {
    Approved: "dispatch.approved",
    Denied: "dispatch.denied",
  },
  "sar-alerts-triage": {
    Confirmed: "alert.confirmed",
    Dismissed: "alert.dismissed",
  },
};

/** The Temporal namespace the SAR workflows run in (see ansa-iceye-SAR). */
export const SAR_TEMPORAL_NAMESPACE = "sar-intel";
