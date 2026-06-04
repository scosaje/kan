/**
 * Inbound half of the bridge: a Kan `card.moved` webhook → a Temporal signal.
 *
 * Kan signs every webhook delivery with HMAC-SHA256 over the raw body
 * (`X-Webhook-Signature`). `verifySignature` mirrors that so the endpoint can
 * reject forgeries, then `handleCardMove` maps the destination list to a signal
 * for the workflow the card is linked to.
 */
import crypto from "node:crypto";

import type { dbClient } from "@kan/db/client";

import { SIGNAL_MAP } from "./constants";
import { getLink } from "./link";
import type { SarSignalSender } from "./temporal";

/** Minimal shape of Kan's webhook payload we depend on (a subset of
 *  @kan/api's WebhookPayload — duplicated to avoid an api→bridge cycle). */
export interface CardWebhookPayload {
  event: string;
  timestamp?: string;
  data?: {
    card?: { id?: string; listId?: string };
    board?: { id?: string; name?: string };
    list?: { id?: string; name?: string };
  };
}

export type CardMoveResult =
  | { status: "signalled"; workflowId: string; signal: string; toList: string }
  | { status: "ignored"; reason: string };

/** Constant-time verification of Kan's HMAC-SHA256 webhook signature. */
export function verifySignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Translate a `card.moved` event into a Temporal signal. A move that doesn't
 * correspond to a linked SAR card, or to a list with no mapped signal, is a
 * deliberate no-op (operators move cards freely).
 */
export async function handleCardMove(
  db: dbClient,
  payload: CardWebhookPayload,
  sender: SarSignalSender,
): Promise<CardMoveResult> {
  if (payload.event !== "card.moved") {
    return { status: "ignored", reason: `event '${payload.event}' is not card.moved` };
  }
  const cardPublicId = payload.data?.card?.id;
  if (!cardPublicId) {
    return { status: "ignored", reason: "payload has no card id" };
  }
  const link = await getLink(db, cardPublicId);
  if (!link) {
    return { status: "ignored", reason: "card is not linked to a SAR workflow" };
  }
  const toList = payload.data?.list?.name;
  if (!toList) {
    return { status: "ignored", reason: "payload has no destination list name" };
  }
  const signal = SIGNAL_MAP[link.boardSlug]?.[toList];
  if (!signal) {
    return {
      status: "ignored",
      reason: `no signal mapped for ${link.boardSlug} → '${toList}'`,
    };
  }

  await sender.signalWorkflow(link.workflowId, signal, {
    actor_id: "kan",
    reason: `Moved to ${toList}`,
  });

  return { status: "signalled", workflowId: link.workflowId, signal, toList };
}
