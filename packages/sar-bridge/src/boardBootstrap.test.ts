import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@kan/db/repository/board.repo", () => ({ create: vi.fn() }));
vi.mock("@kan/db/repository/list.repo", () => ({ create: vi.fn() }));

import * as boardRepo from "@kan/db/repository/board.repo";
import * as listRepo from "@kan/db/repository/list.repo";

import { bootstrap } from "./boardBootstrap";

const mockBoardCreate = boardRepo.create as ReturnType<typeof vi.fn>;
const mockListCreate = listRepo.create as ReturnType<typeof vi.fn>;

describe("bootstrap", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates the Phase 1 board + lists when nothing exists (idempotent path: missing)", async () => {
    let boardId = 0;
    mockBoardCreate.mockImplementation(() => Promise.resolve({ id: ++boardId }));
    mockListCreate.mockResolvedValue({ id: 1 });
    const db = {
      query: {
        boards: { findFirst: vi.fn().mockResolvedValue(undefined) },
        lists: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    } as never;

    const summary = await bootstrap(db, 7, "user-uuid");

    // Phase 1 default = just wz-lifecycle (5 lists).
    expect(summary.boardsCreated).toBe(1);
    expect(summary.listsCreated).toBe(5);
    expect(mockBoardCreate).toHaveBeenCalledTimes(1);
    expect(mockListCreate).toHaveBeenCalledTimes(5);
  });

  it("is idempotent: existing board + lists are left untouched", async () => {
    const db = {
      query: {
        boards: { findFirst: vi.fn().mockResolvedValue({ id: 100 }) },
        lists: { findFirst: vi.fn().mockResolvedValue({ id: 200 }) },
      },
    } as never;

    const summary = await bootstrap(db, 7, "user-uuid");

    expect(summary.boardsCreated).toBe(0);
    expect(summary.boardsExisting).toBe(1);
    expect(summary.listsCreated).toBe(0);
    expect(summary.listsExisting).toBe(5);
    expect(mockBoardCreate).not.toHaveBeenCalled();
    expect(mockListCreate).not.toHaveBeenCalled();
  });

  it("includes Phase 2 boards when asked", async () => {
    mockBoardCreate.mockResolvedValue({ id: 1 });
    mockListCreate.mockResolvedValue({ id: 1 });
    const db = {
      query: {
        boards: { findFirst: vi.fn().mockResolvedValue(undefined) },
        lists: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    } as never;

    const summary = await bootstrap(db, 7, "user-uuid", { includePhase2: true });
    expect(summary.boardsCreated).toBe(5);
  });
});
