import { beforeEach, describe, expect, it, vi } from "vitest";

// Decouple from drizzle internals + the real schema/repo/link modules.
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
  isNull: (...a: unknown[]) => a,
  sql: () => ({}),
}));
vi.mock("@kan/db/schema", () => ({
  boards: { workspaceId: "workspaceId", slug: "slug", deletedAt: "deletedAt" },
  lists: { boardId: "boardId", name: "name", deletedAt: "deletedAt" },
}));
vi.mock("@kan/db/repository/card.repo", () => ({ create: vi.fn() }));
vi.mock("./link", () => ({ recordLink: vi.fn(), getLink: vi.fn(), ensureLinkTable: vi.fn() }));

import * as cardRepo from "@kan/db/repository/card.repo";

import { createCardForWorkflow } from "./createCard";
import { recordLink } from "./link";

const mockCardCreate = cardRepo.create as ReturnType<typeof vi.fn>;
const mockRecordLink = recordLink as ReturnType<typeof vi.fn>;

function makeDb(board: unknown, list: unknown) {
  return {
    query: {
      boards: { findFirst: vi.fn().mockResolvedValue(board) },
      lists: { findFirst: vi.fn().mockResolvedValue(list) },
    },
  } as never;
}

const input = {
  workspaceId: 7,
  board: "watchZoneLifecycle" as const,
  list: "Proposed",
  title: "WZ wz-1234",
  workflowId: "wf-1",
  workflowType: "WatchZoneLifecycleWorkflow",
  createdBy: "user-uuid",
};

describe("createCardForWorkflow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates the card on the resolved board/list and links it to the workflow", async () => {
    mockCardCreate.mockResolvedValue({ publicId: "card-xyz" });
    const db = makeDb({ id: 100 }, { id: 200 });

    const res = await createCardForWorkflow(db, input);

    expect(res.cardPublicId).toBe("card-xyz");
    expect(mockCardCreate).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ listId: 200, workspaceId: 7, position: "end", createdBy: "user-uuid" }),
    );
    expect(mockRecordLink).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        cardPublicId: "card-xyz",
        workflowId: "wf-1",
        boardSlug: "wz-lifecycle",
      }),
    );
  });

  it("throws when the board has not been bootstrapped", async () => {
    const db = makeDb(undefined, { id: 200 });
    await expect(createCardForWorkflow(db, input)).rejects.toThrow(/board/i);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("throws when the destination list does not exist", async () => {
    const db = makeDb({ id: 100 }, undefined);
    await expect(createCardForWorkflow(db, input)).rejects.toThrow(/list/i);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });
});
