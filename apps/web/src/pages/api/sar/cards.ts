/**
 * SAR bridge service endpoint — outbound (workflow → Kan).
 *
 * A SAR Temporal workflow (running server-side, with no Kan user session)
 * POSTs here to represent itself as a card on a SAR board. Authenticated with a
 * shared service key (X-SAR-Service-Key === KAN_SAR_SERVICE_KEY) rather than a
 * user session; the card is attributed to a configured system user
 * (KAN_SAR_SYSTEM_USER_ID, overridable per-request via `createdBy`).
 *
 * The authenticated, user-facing path is the tRPC `sar.createCardForWorkflow`
 * procedure; this endpoint is the service-to-service equivalent.
 */
import crypto from "node:crypto";

import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { createDrizzleClient } from "@kan/db/client";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { createCardForWorkflow } from "@kan/sar-bridge";

const bodySchema = z.object({
  workspacePublicId: z.string().min(12),
  board: z.enum([
    "watchZoneLifecycle",
    "alertsTriage",
    "taskingQueue",
    "dispatchRequests",
    "retrospectiveCases",
  ]),
  list: z.string().min(1),
  title: z.string().min(1).max(255),
  description: z.string().max(10_000).optional(),
  workflowId: z.string().min(1),
  workflowType: z.string().min(1),
  createdBy: z.string().uuid().optional(),
});

function keysMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const serviceKey = process.env.KAN_SAR_SERVICE_KEY;
  if (!serviceKey) {
    res.status(503).json({ error: "SAR service endpoint is not configured" });
    return;
  }
  const presented = req.headers["x-sar-service-key"];
  const presentedKey = Array.isArray(presented) ? presented[0] : presented;
  if (!presentedKey || !keysMatch(presentedKey, serviceKey)) {
    res.status(401).json({ error: "Invalid service key" });
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;

  const createdBy = input.createdBy ?? process.env.KAN_SAR_SYSTEM_USER_ID;
  if (!createdBy) {
    res
      .status(503)
      .json({ error: "No createdBy and KAN_SAR_SYSTEM_USER_ID is not set" });
    return;
  }

  const db = createDrizzleClient();
  const workspace = await workspaceRepo.getByPublicId(db, input.workspacePublicId);
  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }

  try {
    const result = await createCardForWorkflow(db, {
      workspaceId: workspace.id,
      board: input.board,
      list: input.list,
      title: input.title,
      description: input.description,
      workflowId: input.workflowId,
      workflowType: input.workflowType,
      createdBy,
    });
    res.status(201).json(result);
  } catch (err) {
    // Board/list-not-found (un-bootstrapped) and the like are operator errors.
    res.status(400).json({
      error: err instanceof Error ? err.message : "Failed to create SAR card",
    });
  }
}
