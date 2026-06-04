/**
 * Card ↔ workflow link store.
 *
 * Kan's `cards` table has no free-form metadata column, so the bridge keeps a
 * dedicated `sar_card_workflow` table (defined in @kan/db's schema + migrations)
 * mapping a card's public id to the Temporal workflow it represents.
 */
import { eq } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { sarCardWorkflows } from "@kan/db/schema";

export interface WorkflowLink {
  workflowId: string;
  workflowType: string;
  boardSlug: string;
}

/** Record (or refresh) the link from a card to its workflow. Idempotent on the
 *  card's public id, so re-creating a card for the same workflow is safe. */
export async function recordLink(
  db: dbClient,
  link: WorkflowLink & { cardPublicId: string },
): Promise<void> {
  await db
    .insert(sarCardWorkflows)
    .values({
      cardPublicId: link.cardPublicId,
      workflowId: link.workflowId,
      workflowType: link.workflowType,
      boardSlug: link.boardSlug,
    })
    .onConflictDoUpdate({
      target: sarCardWorkflows.cardPublicId,
      set: {
        workflowId: link.workflowId,
        workflowType: link.workflowType,
        boardSlug: link.boardSlug,
      },
    });
}

/** Look up the workflow a card represents, or null if it isn't a SAR card. */
export async function getLink(
  db: dbClient,
  cardPublicId: string,
): Promise<WorkflowLink | null> {
  const [row] = await db
    .select({
      workflowId: sarCardWorkflows.workflowId,
      workflowType: sarCardWorkflows.workflowType,
      boardSlug: sarCardWorkflows.boardSlug,
    })
    .from(sarCardWorkflows)
    .where(eq(sarCardWorkflows.cardPublicId, cardPublicId))
    .limit(1);

  return row ?? null;
}
