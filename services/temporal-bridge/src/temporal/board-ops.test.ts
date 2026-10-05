import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";

const kanMock = vi.hoisted(() => ({
  getCard: vi.fn(),
  getBoard: vi.fn(),
  postComment: vi.fn(),
  moveCard: vi.fn(),
  createLabel: vi.fn(),
  request: vi.fn(),
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
import {
  createCard, ensureLabels, getCard, KAN_CARD_NOT_FOUND, keepHiddenBlocks, moveCardToLane,
  postComment, syncCard,
} from "./board-ops.js";

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

// Writes succeed unless a test says otherwise (earlier tests make them 404).
function writesSucceed() {
  for (const fn of [kanMock.moveCard, kanMock.postComment, kanMock.request]) fn.mockResolvedValue(undefined);
}

// GET /cards/{id} as Kan returns it: lane, board lanes + labels, comments.
function cardIn(lane: string, opts: { labels?: string[]; comments?: string[]; description?: string } = {}) {
  const lbl = (name: string) => ({ publicId: `lbl-${name}`, name, colourCode: null });
  return {
    publicId: CARD,
    title: "INC-1 — Armed robbery",
    description: opts.description ?? "body",
    labels: (opts.labels ?? []).map(lbl),
    list: {
      publicId: `lst-${lane}`,
      name: lane,
      board: {
        publicId: BOARD,
        name: "sis-incidents-npf",
        lists: ["DETECTED", "RESPONDING", "ON_SCENE"].map((n) => ({ publicId: `lst-${n}`, name: n })),
        labels: ["FLASH", "CRITICAL", "HIGH", "ON SCENE"].map(lbl),
      },
    },
    activities: (opts.comments ?? []).map((c) => ({ type: "card.updated.comment.added", comment: { comment: c } })),
  };
}

describe("syncCard", () => {
  beforeEach(writesSucceed);
  it("sends nothing when the card already matches", async () => {
    kanMock.getCard.mockResolvedValue(
      cardIn("RESPONDING", { labels: ["HIGH"], comments: ["Tasked\n<!--kan-idem:k1-->"] }),
    );
    const out = await syncCard(CARD, BOARD, { lane: "responding", addLabels: ["HIGH"], comment: "Tasked" }, "k1");
    expect(out).toEqual({ changed: [] });
    expect(kanMock.moveCard).not.toHaveBeenCalled();
    expect(kanMock.request).not.toHaveBeenCalled();
    expect(kanMock.postComment).not.toHaveBeenCalled();
  });

  it("moves, swaps labels and comments from a single read", async () => {
    kanMock.getCard.mockResolvedValue(cardIn("RESPONDING", { labels: ["HIGH"] }));
    const out = await syncCard(
      CARD, BOARD,
      { lane: "ON_SCENE", addLabels: ["CRITICAL", "FLASH", "NOT ON BOARD"], removeLabels: ["HIGH", "ON SCENE"],
        comment: "On scene" },
      "k2",
    );
    expect(out.changed).toEqual(["lane:ON_SCENE", "+CRITICAL", "+FLASH", "-HIGH", "comment"]);
    expect(kanMock.getCard).toHaveBeenCalledTimes(1);
    expect(kanMock.getBoard).not.toHaveBeenCalled();
    expect(kanMock.moveCard).toHaveBeenCalledWith(CARD, "lst-ON_SCENE");
    expect(kanMock.request.mock.calls.map((c) => c[1])).toEqual([
      `/cards/${CARD}/labels/lbl-CRITICAL`, `/cards/${CARD}/labels/lbl-FLASH`, `/cards/${CARD}/labels/lbl-HIGH`,
    ]);
    expect(kanMock.postComment).toHaveBeenCalledWith(CARD, "On scene\n<!--kan-idem:k2-->");
  });

  it("rewrites the description keeping the meta block and creation tag", async () => {
    const meta = '<!--mandate-meta:{"mandate":{"workflow_id":"wf"}}-->';
    kanMock.getCard.mockResolvedValue(cardIn("DETECTED", { description: `old\n\n${meta}\n\n<!--kan-idem:c1-->` }));
    await syncCard(CARD, BOARD, { description: "<p>new</p>" });
    expect(kanMock.request).toHaveBeenCalledWith("PUT", `/cards/${CARD}`, {
      description: `<p>new</p>\n\n${meta}\n\n<!--kan-idem:c1-->`,
    });
  });

  it("refuses a lane the board lacks", async () => {
    kanMock.getCard.mockResolvedValue(cardIn("DETECTED"));
    await expect(syncCard(CARD, BOARD, { lane: "TASKING" })).rejects.toThrow(/Lane "TASKING"/);
  });
});

describe("keepHiddenBlocks", () => {
  it("does not duplicate blocks the new text already has", () => {
    const prev = 'a <!--mandate-meta:{"x":1}--> <!--kan-idem:t-->';
    const next = 'b <!--mandate-meta:{"x":2}--> <!--kan-idem:t-->';
    expect(keepHiddenBlocks(next, prev)).toBe(next);
  });
});

describe("duplicate guards", () => {
  beforeEach(writesSucceed);
  it("createCard finds its card in any lane by the caller's key", async () => {
    kanMock.getBoard.mockResolvedValue({
      labels: [],
      lists: [
        { publicId: "lst-DETECTED", name: "DETECTED", cards: [] },
        { publicId: "lst-ON_SCENE", name: "ON_SCENE", cards: [{ publicId: "existing0001", description: "x\n\n<!--kan-idem:wf:create-->" }] },
      ],
    });
    expect(await createCard(BOARD, "DETECTED", "t", "x", [], "wf:create")).toEqual({ publicId: "existing0001" });
    expect(kanMock.request).not.toHaveBeenCalled();
  });
});
