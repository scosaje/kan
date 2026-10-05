import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";

const kanMock = vi.hoisted(() => ({
  getCard: vi.fn(),
  getBoard: vi.fn(),
  postComment: vi.fn(),
  moveCard: vi.fn(),
  createLabel: vi.fn(),
}));

vi.mock("../config.js", () => ({ config: {} }));
vi.mock("../log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../kanClient.js", async () => {
  class KanHttpError extends Error {
    constructor(
      readonly method: string,
      readonly path: string,
      readonly status: number,
      body: string,
    ) {
      super(`Kan ${method} ${path} -> ${status}: ${body}`);
    }
  }
  return { kan: kanMock, KanHttpError };
});

import { KanHttpError } from "../kanClient.js";
import { ensureLabels, getCard, KAN_CARD_NOT_FOUND, moveCardToLane, postComment } from "./board-ops.js";

const CARD = "vi9as7r8g1ui";
const BOARD = "dr9x5vu0qs9x";
const gone = () => new KanHttpError("GET", `/cards/${CARD}`, 404, "Card not found");

async function failureOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a failure");
}

beforeEach(() => {
  vi.clearAllMocks();
  kanMock.getBoard.mockResolvedValue({ lists: [{ publicId: "lstdone00001", name: "DONE" }] });
});

describe("card-not-found failures", () => {
  it("getCard reports a deleted card as a final KanCardNotFound failure", async () => {
    kanMock.getCard.mockRejectedValue(gone());
    const e = await failureOf(getCard(CARD));
    expect(e).toBeInstanceOf(ApplicationFailure);
    expect((e as ApplicationFailure).type).toBe(KAN_CARD_NOT_FOUND);
    expect((e as ApplicationFailure).nonRetryable).toBe(true);
  });

  it("postComment on a deleted card fails the same way", async () => {
    kanMock.getCard.mockRejectedValue(gone()); // duplicate pre-check
    kanMock.postComment.mockRejectedValue(
      new KanHttpError("POST", `/cards/${CARD}/comments`, 404, "Card not found"),
    );
    const e = await failureOf(postComment(CARD, "hello"));
    expect((e as ApplicationFailure).type).toBe(KAN_CARD_NOT_FOUND);
  });

  it("moveCardToLane on a deleted card fails the same way", async () => {
    kanMock.moveCard.mockRejectedValue(new KanHttpError("PUT", `/cards/${CARD}`, 404, "Card not found"));
    const e = await failureOf(moveCardToLane(CARD, BOARD, "DONE"));
    expect((e as ApplicationFailure).type).toBe(KAN_CARD_NOT_FOUND);
  });

  it("leaves other failures retryable and untouched", async () => {
    const serverError = new KanHttpError("GET", `/cards/${CARD}`, 500, "boom");
    kanMock.getCard.mockRejectedValue(serverError);
    expect(await failureOf(getCard(CARD))).toBe(serverError);
  });

  it("does not blame the card for a missing board", async () => {
    const boardGone = new KanHttpError("GET", `/boards/${BOARD}`, 404, "Board not found");
    kanMock.getBoard.mockRejectedValue(boardGone);
    expect(await failureOf(moveCardToLane(CARD, BOARD, "DONE"))).toBe(boardGone);
  });
});

describe("ensureLabels", () => {
  it("creates only the labels the board lacks, matching names case-insensitively", async () => {
    kanMock.getBoard.mockResolvedValue({ lists: [], labels: [{ name: "Flash", publicId: "lbl1" }] });
    const out = await ensureLabels(BOARD, [
      { name: "FLASH", colour: "#dc2626" },
      { name: "ARMED", colour: "#b91c1c" },
      { name: "armed", colour: "#000000" },
    ]);
    expect(out).toEqual({ created: ["ARMED"] });
    expect(kanMock.createLabel).toHaveBeenCalledTimes(1);
    expect(kanMock.createLabel).toHaveBeenCalledWith(BOARD, "ARMED", "#b91c1c");
  });
});
