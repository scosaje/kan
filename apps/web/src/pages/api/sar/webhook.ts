/**
 * SAR bridge webhook endpoint.
 *
 * Receives Kan's native `card.moved` webhook (configure a workspace webhook
 * pointing here, subscribed to `card.moved`, with a shared secret) and turns a
 * card move into a Temporal signal for the workflow the card represents.
 *
 * The body parser is disabled so the raw body is available for HMAC-SHA256
 * signature verification (Kan signs with the webhook's secret →
 * `X-Webhook-Signature`). KAN_WEBHOOK_SECRET must match that secret.
 */
import type { NextApiRequest, NextApiResponse } from "next";

import { createDrizzleClient } from "@kan/db/client";
import type { CardWebhookPayload } from "@kan/sar-bridge";
import {
  createSignalSender,
  handleCardMove,
  verifySignature,
} from "@kan/sar-bridge";

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req: NextApiRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const secret = process.env.KAN_WEBHOOK_SECRET;
  if (!secret) {
    res.status(503).json({ error: "SAR webhook is not configured" });
    return;
  }

  const rawBody = await readRawBody(req);
  const sigHeader = req.headers["x-webhook-signature"];
  const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  if (!verifySignature(rawBody, signature, secret)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let payload: CardWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as CardWebhookPayload;
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  // Acknowledge non-move events without touching Temporal.
  if (payload.event !== "card.moved") {
    res.status(204).end();
    return;
  }

  const db = createDrizzleClient();
  const { sender, close } = await createSignalSender();
  try {
    const result = await handleCardMove(db, payload, sender);
    res.status(200).json(result);
  } catch (err) {
    console.error("SAR webhook error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await close().catch(() => undefined);
  }
}
