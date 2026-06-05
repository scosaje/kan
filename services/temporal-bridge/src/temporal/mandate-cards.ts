/**
 * MANDATE-owned card support for the bridge's webhook handler.
 *
 * The 4 MANDATE domain workflows (IncidentResponseWorkflow,
 * POIActionWorkflow, TaskingDispatchWorkflow, SISTriadGateWorkflow) embed
 * a JSON `mandate` block in every Kan card description they create, as
 * an `<!--mandate-meta:{...}-->` HTML comment. The block tells the
 * bridge:
 *
 *   - which workflow (`workflow_id`, `namespace`) owns the card,
 *   - which transitions are operator-draggable (`signal_map`,
 *     `operator_allowed_transitions`),
 *   - the human primary id (`primary_id`) for logs / comments.
 *
 * On `card.moved`, this module is what the webhook handler delegates to.
 * It reads the metadata, validates the requested transition against the
 * whitelist, and signals the workflow. Rejected drags get a
 * `[rejected]` comment back on the card; out-of-bound drags get a
 * `[no signal for FROM->TO]` comment. Cards without a `mandate-meta`
 * block are left to the legacy KanCardWorkflow / LaneAgent paths.
 */

import { Client as TemporalClient, WorkflowNotFoundError } from "@temporalio/client";

import { kan, type KanCard } from "../kanClient.js";
import { log } from "../log.js";
import { postComment, moveCardToLane } from "./board-ops.js";

const MANDATE_META_PREFIX = "<!--mandate-meta:";
const MANDATE_META_SUFFIX = "-->";
const MANDATE_META_RE = new RegExp(
  `${escapeRegExp(MANDATE_META_PREFIX)}([\\s\\S]*?)${escapeRegExp(MANDATE_META_SUFFIX)}`,
);

export interface MandateMeta {
  domain: string;
  workflow_id: string;
  workflow_type: string;
  namespace: string;
  primary_id: string;
  role: string;
  linked_card_ids: string[];
  signal_map: Record<string, string>;
  operator_allowed_transitions: string[];
  schema_version: number;
}

/**
 * Parse the embedded `mandate` block from a card description. Returns
 * `null` when no block is present, the block is malformed, or the
 * outer wrapper doesn't carry a `mandate` key.
 */
export function extractMandateMeta(
  description: string | null | undefined,
): MandateMeta | null {
  if (!description) return null;
  const match = description.match(MANDATE_META_RE);
  if (!match || !match[1]) return null;
  let outer: unknown;
  try {
    outer = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!outer || typeof outer !== "object") return null;
  const block = (outer as Record<string, unknown>).mandate;
  if (!block || typeof block !== "object") return null;
  const m = block as Partial<MandateMeta>;
  // Minimal shape check — we only forward signals if these keys land.
  if (typeof m.workflow_id !== "string" || !m.workflow_id) return null;
  if (typeof m.namespace !== "string" || !m.namespace) return null;
  // Sensible defaults for optional members so consumers don't have to
  // re-check every field.
  return {
    domain: typeof m.domain === "string" ? m.domain : "",
    workflow_id: m.workflow_id,
    workflow_type: typeof m.workflow_type === "string" ? m.workflow_type : "",
    namespace: m.namespace,
    primary_id: typeof m.primary_id === "string" ? m.primary_id : "",
    role: typeof m.role === "string" ? m.role : "lead",
    linked_card_ids: Array.isArray(m.linked_card_ids)
      ? m.linked_card_ids.filter((x): x is string => typeof x === "string")
      : [],
    signal_map:
      m.signal_map && typeof m.signal_map === "object"
        ? Object.fromEntries(
            Object.entries(m.signal_map).filter(
              ([, v]) => typeof v === "string",
            ),
          )
        : {},
    operator_allowed_transitions: Array.isArray(m.operator_allowed_transitions)
      ? m.operator_allowed_transitions.filter((x): x is string => typeof x === "string")
      : [],
    schema_version: typeof m.schema_version === "number" ? m.schema_version : 1,
  };
}

interface CardMovePayload {
  cardPublicId: string;
  boardPublicId: string;
  fromLane?: string;
  toLane: string;
  /** Best-effort actor identity from the webhook (Kan may not include it). */
  requestedBy?: string;
}

/**
 * Handle a `card.moved` event for a MANDATE-owned card. Returns true
 * if the card is MANDATE-owned (caller should NOT fall through to the
 * legacy KanCardWorkflow / LaneAgent paths), false otherwise.
 *
 * The function reads the card to obtain the description, then:
 *   1. Returns false if no `mandate-meta` block is present.
 *   2. Validates `fromLane->toLane` against `operator_allowed_transitions`.
 *      Rejects with a `[rejected]` comment if absent.
 *   3. Looks up the signal name from `signal_map[transition_key]`.
 *      Comments `[no signal]` if absent — shouldn't happen if the YAML
 *      and the embedded metadata stay in sync, but the comment makes
 *      debugging painless.
 *   4. Signals the workflow with the standard payload:
 *      `{requested_by, card_public_id, from_lane, to_lane}`.
 *   5. If the workflow no longer exists, comments `[stale]` and stops.
 */
export async function handleMandateCardMove(
  payload: CardMovePayload,
  temporal: TemporalClient,
): Promise<boolean> {
  const { cardPublicId, fromLane, toLane, requestedBy } = payload;

  let card: KanCard;
  try {
    card = await kan.getCard(cardPublicId);
  } catch (e) {
    log.warn(
      { cardPublicId, err: (e as Error).message },
      "mandate: getCard failed — leaving to legacy path",
    );
    return false;
  }

  const meta = extractMandateMeta(card.description);
  if (!meta) return false;

  if (!fromLane) {
    // Without a fromLane we can't compute the transition key. Log and
    // signal nothing — the operator drag is effectively a no-op on
    // MANDATE-owned cards from the bridge's perspective.
    log.warn(
      { cardPublicId, workflow_id: meta.workflow_id },
      "mandate: card.moved without fromLane — cannot validate transition",
    );
    return true;
  }

  const key = `${fromLane}->${toLane}`;

  if (!meta.operator_allowed_transitions.includes(key)) {
    const body =
      `[rejected] MANDATE workflow rules don't allow operator-drag from ${fromLane} ` +
      `to ${toLane} on this card.`;
    await safeComment(cardPublicId, body);
    // Best-effort: nudge the card back. The bridge can't truly revert a
    // Kan move without knowing the previous list, but moving it back to
    // `fromLane` is the right semantic.
    try {
      await moveCardToLane(cardPublicId, payload.boardPublicId, fromLane);
    } catch (e) {
      log.warn(
        { cardPublicId, err: (e as Error).message },
        "mandate: revert moveCardToLane failed (continuing)",
      );
    }
    log.info({ cardPublicId, key }, "mandate: rejected disallowed drag");
    return true;
  }

  const signalName = meta.signal_map[key];
  if (!signalName) {
    await safeComment(
      cardPublicId,
      `[no signal] MANDATE has no signal mapped for ${key}; lane move ignored.`,
    );
    log.warn({ cardPublicId, key }, "mandate: no signal in signal_map");
    return true;
  }

  try {
    const handle = temporal.workflow.getHandle(meta.workflow_id);
    await handle.signal(signalName, {
      requested_by: requestedBy ?? "kan-operator",
      card_public_id: cardPublicId,
      from_lane: fromLane,
      to_lane: toLane,
    });
    log.info(
      { cardPublicId, workflow_id: meta.workflow_id, signalName, key },
      "mandate: signalled workflow on operator drag",
    );
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) {
      await safeComment(
        cardPublicId,
        `[stale] Workflow ${meta.workflow_id} has already terminated; ` +
          `card transitions are read-only.`,
      );
      log.info(
        { cardPublicId, workflow_id: meta.workflow_id, key },
        "mandate: workflow no longer running — stale drag",
      );
    } else {
      log.error(
        {
          cardPublicId,
          workflow_id: meta.workflow_id,
          err: (e as Error).message,
        },
        "mandate: signal failed",
      );
      // Don't comment here — surfacing transient Temporal errors to
      // operators isn't helpful; the workflow will see the drag again
      // on the next webhook delivery (Kan retries failed deliveries).
    }
  }

  return true;
}

async function safeComment(cardPublicId: string, body: string): Promise<void> {
  try {
    await postComment(cardPublicId, body);
  } catch (e) {
    log.warn(
      { cardPublicId, err: (e as Error).message },
      "mandate: safeComment failed (continuing)",
    );
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
