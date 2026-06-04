/**
 * createCardForWorkflow — the outbound half of the bridge: a SAR Temporal
 * workflow asks Kan to represent it as a card on the right board/list, and the
 * card is linked back to the workflow so a later move can signal it.
 */
import { and, eq, isNull } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import { boards, lists } from "@kan/db/schema";

import type { SarBoardKey } from "./constants";
import { SAR_BOARD_SLUGS } from "./constants";
import { recordLink } from "./link";

export interface CreateCardForWorkflowInput {
  /** Workspace that owns the SAR boards. */
  workspaceId: number;
  /** Which SAR board (logical key, mapped to a slug). */
  board: SarBoardKey;
  /** Destination list name on that board (e.g. "Proposed"). */
  list: string;
  title: string;
  description?: string;
  /** Temporal workflow this card represents. */
  workflowId: string;
  workflowType: string;
  /** Kan user id (uuid) the card is attributed to. */
  createdBy: string;
}

export interface CreateCardForWorkflowResult {
  cardPublicId: string;
}

export async function createCardForWorkflow(
  db: dbClient,
  input: CreateCardForWorkflowInput,
): Promise<CreateCardForWorkflowResult> {
  const slug = SAR_BOARD_SLUGS[input.board];

  const board = await db.query.boards.findFirst({
    columns: { id: true },
    where: and(
      eq(boards.workspaceId, input.workspaceId),
      eq(boards.slug, slug),
      isNull(boards.deletedAt),
    ),
  });
  if (!board) {
    throw new Error(
      `SAR board '${input.board}' (slug '${slug}') not found in workspace ${input.workspaceId}; run the bootstrap script`,
    );
  }

  const list = await db.query.lists.findFirst({
    columns: { id: true },
    where: and(
      eq(lists.boardId, board.id),
      eq(lists.name, input.list),
      isNull(lists.deletedAt),
    ),
  });
  if (!list) {
    throw new Error(`List '${input.list}' not found on board '${input.board}'`);
  }

  const card = await cardRepo.create(db, {
    title: input.title,
    description: input.description ?? "",
    createdBy: input.createdBy,
    listId: list.id,
    workspaceId: input.workspaceId,
    position: "end",
  });

  await recordLink(db, {
    cardPublicId: card.publicId,
    workflowId: input.workflowId,
    workflowType: input.workflowType,
    boardSlug: slug,
  });

  return { cardPublicId: card.publicId };
}
