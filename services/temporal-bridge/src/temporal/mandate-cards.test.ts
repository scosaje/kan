import { beforeEach, describe, expect, it, vi } from "vitest";

const kanMock = vi.hoisted(() => ({
  getCard: vi.fn(),
  selfUserId: vi.fn(),
}));
const opsMock = vi.hoisted(() => ({
  postComment: vi.fn(),
  moveCardToLane: vi.fn(),
}));

vi.mock("../kanClient.js", () => ({ kan: kanMock }));
vi.mock("./board-ops.js", () => opsMock);
vi.mock("../log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleMandateCardMove } from "./mandate-cards.js";

const BRIDGE_USER = "3f0c1b8e-bridge-user";
const OPERATOR = "9a7d2c11-operator";
const CARD = "7yqr8cvpzbwt";
const BOARD = "8fppzwocpx1k";

function mandateCard() {
  const meta = {
    mandate: {
      domain: "sis_incidents",
      workflow_id: "incident-test-1",
      workflow_type: "IncidentResponseWorkflow",
      namespace: "default",
      primary_id: "INC-TEST",
      role: "lead",
      linked_card_ids: [],
      signal_map: { "RESPONDING->ON_SCENE": "incident_on_scene" },
      operator_allowed_transitions: ["RESPONDING->ON_SCENE"],
      schema_version: 1,
    },
  };
  return { publicId: CARD, description: `Incident\n\n<!--mandate-meta:${JSON.stringify(meta)}-->` };
}

function temporalMock() {
  const signal = vi.fn();
  return {
    signal,
    client: { workflow: { getHandle: vi.fn(() => ({ signal })) } } as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  kanMock.getCard.mockResolvedValue(mandateCard());
  kanMock.selfUserId.mockResolvedValue(BRIDGE_USER);
});

describe("handleMandateCardMove", () => {
  it("ignores a move the bridge made itself — no rejection, no revert, no signal", async () => {
    const t = temporalMock();
    const handled = await handleMandateCardMove(
      { cardPublicId: CARD, boardPublicId: BOARD, fromLane: "ACKNOWLEDGED", toLane: "RESPONDING", actorUserId: BRIDGE_USER },
      t.client,
    );
    expect(handled).toBe(true);
    expect(opsMock.postComment).not.toHaveBeenCalled();
    expect(opsMock.moveCardToLane).not.toHaveBeenCalled();
    expect(t.signal).not.toHaveBeenCalled();
  });

  it("ignores the echo of its own revert, so a rejected drag cannot ping-pong", async () => {
    const t = temporalMock();
    // Operator drags RESPONDING -> CLOSED: rejected and reverted once.
    await handleMandateCardMove(
      { cardPublicId: CARD, boardPublicId: BOARD, fromLane: "RESPONDING", toLane: "CLOSED", actorUserId: OPERATOR },
      t.client,
    );
    // Kan then reports the bridge's revert CLOSED -> RESPONDING.
    await handleMandateCardMove(
      { cardPublicId: CARD, boardPublicId: BOARD, fromLane: "CLOSED", toLane: "RESPONDING", actorUserId: BRIDGE_USER },
      t.client,
    );
    expect(opsMock.postComment).toHaveBeenCalledTimes(1);
    expect(opsMock.moveCardToLane).toHaveBeenCalledTimes(1);
    expect(opsMock.moveCardToLane).toHaveBeenCalledWith(CARD, BOARD, "RESPONDING");
  });

  it("still rejects and reverts an operator's disallowed drag", async () => {
    const t = temporalMock();
    const handled = await handleMandateCardMove(
      { cardPublicId: CARD, boardPublicId: BOARD, fromLane: "RESPONDING", toLane: "CLOSED", actorUserId: OPERATOR },
      t.client,
    );
    expect(handled).toBe(true);
    expect(opsMock.postComment.mock.calls[0]?.[1]).toMatch(/^\[rejected\]/);
    expect(t.signal).not.toHaveBeenCalled();
  });

  it("still signals the workflow for an operator's allowed drag, naming the operator", async () => {
    const t = temporalMock();
    await handleMandateCardMove(
      {
        cardPublicId: CARD,
        boardPublicId: BOARD,
        fromLane: "RESPONDING",
        toLane: "ON_SCENE",
        actorUserId: OPERATOR,
        requestedBy: "Duty Officer",
      },
      t.client,
    );
    expect(t.signal).toHaveBeenCalledWith("incident_on_scene", {
      requested_by: "Duty Officer",
      card_public_id: CARD,
      from_lane: "RESPONDING",
      to_lane: "ON_SCENE",
    });
    expect(opsMock.moveCardToLane).not.toHaveBeenCalled();
  });

  it("treats a move with no actor as an operator's, as before", async () => {
    const t = temporalMock();
    await handleMandateCardMove(
      { cardPublicId: CARD, boardPublicId: BOARD, fromLane: "RESPONDING", toLane: "CLOSED" },
      t.client,
    );
    expect(opsMock.moveCardToLane).toHaveBeenCalledTimes(1);
  });

  it("falls back to old behaviour when the bridge's own id is unknown", async () => {
    kanMock.selfUserId.mockResolvedValue(null);
    const t = temporalMock();
    await handleMandateCardMove(
      { cardPublicId: CARD, boardPublicId: BOARD, fromLane: "RESPONDING", toLane: "CLOSED", actorUserId: BRIDGE_USER },
      t.client,
    );
    expect(opsMock.moveCardToLane).toHaveBeenCalledTimes(1);
  });
});
