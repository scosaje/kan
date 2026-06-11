import { describe, expect, it, vi } from "vitest";

import {
  readListChangeFromId,
  readListChangeFromName,
  resolveFromLaneName,
} from "./lane-resolution.js";

const BOARD = "dr9x5vu0qs9x";

const boardLists = {
  lists: [
    { publicId: "lstnominated", name: "NOMINATED" },
    { publicId: "lstapproved1", name: "APPROVED" },
    { publicId: "lstrejected1", name: "REJECTED" },
  ],
};

describe("readListChangeFromName (legacy / forged payload shape)", () => {
  it("returns the name from changes.list.from.name", () => {
    const changes = {
      list: { from: { name: "NOMINATED" }, to: { name: "APPROVED" } },
    };
    expect(readListChangeFromName(changes)).toBe("NOMINATED");
  });

  it("returns undefined when changes is absent", () => {
    expect(readListChangeFromName(undefined)).toBeUndefined();
  });

  it("returns undefined when from has no name", () => {
    expect(
      readListChangeFromName({ list: { from: {}, to: {} } }),
    ).toBeUndefined();
  });
});

describe("readListChangeFromId (real Kan payload shape)", () => {
  it("returns the publicId string from changes.listId.from", () => {
    const changes = {
      listId: { from: "lstnominated", to: "lstapproved1" },
    };
    expect(readListChangeFromId(changes)).toBe("lstnominated");
  });

  it("returns undefined when changes is absent", () => {
    expect(readListChangeFromId(undefined)).toBeUndefined();
  });

  it("returns undefined when listId.from is not a string", () => {
    expect(
      readListChangeFromId({ listId: { from: { name: "X" }, to: "y" } }),
    ).toBeUndefined();
  });
});

describe("resolveFromLaneName", () => {
  it("prefers the direct name shape without fetching the board", async () => {
    const getBoard = vi.fn();
    const changes = {
      list: { from: { name: "NOMINATED" }, to: { name: "APPROVED" } },
    };
    await expect(
      resolveFromLaneName(changes, BOARD, getBoard),
    ).resolves.toBe("NOMINATED");
    expect(getBoard).not.toHaveBeenCalled();
  });

  it("resolves a real Kan changes.listId.from publicId to the lane name", async () => {
    // Regression: real Kan card.moved webhooks carry list *publicIds* in
    // changes.listId, never changes.list.from.name. Before this helper the
    // bridge derived no fromLane and dropped every real operator drag on
    // MANDATE-owned cards ("cannot validate transition").
    const getBoard = vi.fn().mockResolvedValue(boardLists);
    const changes = {
      listId: { from: "lstnominated", to: "lstapproved1" },
    };
    await expect(
      resolveFromLaneName(changes, BOARD, getBoard),
    ).resolves.toBe("NOMINATED");
    expect(getBoard).toHaveBeenCalledWith(BOARD);
  });

  it("returns undefined when the publicId is not on the board", async () => {
    const getBoard = vi.fn().mockResolvedValue(boardLists);
    const changes = { listId: { from: "lstelsewhere", to: "lstapproved1" } };
    await expect(
      resolveFromLaneName(changes, BOARD, getBoard),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when there is no move information at all", async () => {
    const getBoard = vi.fn();
    await expect(
      resolveFromLaneName({ title: { from: "a", to: "b" } }, BOARD, getBoard),
    ).resolves.toBeUndefined();
    expect(getBoard).not.toHaveBeenCalled();
  });

  it("returns undefined when the board fetch fails", async () => {
    const getBoard = vi.fn().mockRejectedValue(new Error("kan down"));
    const changes = { listId: { from: "lstnominated", to: "lstapproved1" } };
    await expect(
      resolveFromLaneName(changes, BOARD, getBoard),
    ).resolves.toBeUndefined();
  });
});
