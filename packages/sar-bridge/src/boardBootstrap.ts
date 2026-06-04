/**
 * Idempotent provisioning of the SAR boards + lists in a Kan workspace, plus
 * the bridge's own link table. Safe to run on every deploy: existing boards and
 * lists are detected by (workspace, slug) and (board, name) and left untouched.
 */
import { and, eq, isNull } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import * as boardRepo from "@kan/db/repository/board.repo";
import * as listRepo from "@kan/db/repository/list.repo";
import { boards, lists } from "@kan/db/schema";

import type { BoardDef } from "./constants";
import { BOARD_DEFS } from "./constants";

export interface BootstrapSummary {
  boardsCreated: number;
  boardsExisting: number;
  listsCreated: number;
  listsExisting: number;
}

async function ensureBoard(
  db: dbClient,
  workspaceId: number,
  def: BoardDef,
  createdBy: string,
): Promise<{ id: number; created: boolean }> {
  const existing = await db.query.boards.findFirst({
    columns: { id: true },
    where: and(
      eq(boards.workspaceId, workspaceId),
      eq(boards.slug, def.slug),
      isNull(boards.deletedAt),
    ),
  });
  if (existing) return { id: existing.id, created: false };

  const created = await boardRepo.create(db, {
    name: def.name,
    slug: def.slug,
    createdBy,
    workspaceId,
  });
  if (!created) throw new Error(`Failed to create SAR board '${def.slug}'`);
  return { id: created.id, created: true };
}

async function ensureList(
  db: dbClient,
  boardId: number,
  name: string,
  createdBy: string,
): Promise<{ created: boolean }> {
  const existing = await db.query.lists.findFirst({
    columns: { id: true },
    where: and(
      eq(lists.boardId, boardId),
      eq(lists.name, name),
      isNull(lists.deletedAt),
    ),
  });
  if (existing) return { created: false };

  await listRepo.create(db, { name, createdBy, boardId });
  return { created: true };
}

export interface BootstrapOptions {
  /** Include Phase 2 placeholder boards (alerts/dispatch/etc). Default false —
   *  Phase 1 only needs the Watch Zone Lifecycle board. */
  includePhase2?: boolean;
}

export async function bootstrap(
  db: dbClient,
  workspaceId: number,
  createdBy: string,
  opts: BootstrapOptions = {},
): Promise<BootstrapSummary> {
  // The sar_card_workflow link table is provisioned by @kan/db migrations, so
  // bootstrap only needs to ensure the boards/lists exist.
  const defs = opts.includePhase2
    ? BOARD_DEFS
    : BOARD_DEFS.filter((d) => d.phase === 1);

  const summary: BootstrapSummary = {
    boardsCreated: 0,
    boardsExisting: 0,
    listsCreated: 0,
    listsExisting: 0,
  };

  for (const def of defs) {
    const board = await ensureBoard(db, workspaceId, def, createdBy);
    if (board.created) summary.boardsCreated++;
    else summary.boardsExisting++;

    for (const listName of def.lists) {
      const list = await ensureList(db, board.id, listName, createdBy);
      if (list.created) summary.listsCreated++;
      else summary.listsExisting++;
    }
  }

  return summary;
}
