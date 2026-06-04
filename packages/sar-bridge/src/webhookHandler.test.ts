import crypto from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the link store so no DB is needed.
vi.mock("./link", () => ({
  getLink: vi.fn(),
  recordLink: vi.fn(),
  ensureLinkTable: vi.fn(),
}));

import { getLink } from "./link";
import type { SarSignalSender } from "./temporal";
import { handleCardMove, verifySignature } from "./webhookHandler";

const mockGetLink = getLink as ReturnType<typeof vi.fn>;
const db = {} as never;

function senderSpy(): SarSignalSender & { signalWorkflow: ReturnType<typeof vi.fn> } {
  return { signalWorkflow: vi.fn().mockResolvedValue(undefined) };
}

describe("verifySignature", () => {
  const secret = "topsecret";
  const body = JSON.stringify({ event: "card.moved" });
  const good = crypto.createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a correct HMAC-SHA256 signature", () => {
    expect(verifySignature(body, good, secret)).toBe(true);
  });
  it("rejects a wrong signature", () => {
    expect(verifySignature(body, "deadbeef", secret)).toBe(false);
  });
  it("rejects a missing signature", () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
  });
});

describe("handleCardMove", () => {
  beforeEach(() => vi.clearAllMocks());

  it("signals the linked workflow when moved to a mapped list", async () => {
    mockGetLink.mockResolvedValue({
      workflowId: "wf-123",
      workflowType: "WatchZoneLifecycleWorkflow",
      boardSlug: "wz-lifecycle",
    });
    const sender = senderSpy();
    const res = await handleCardMove(
      db,
      { event: "card.moved", data: { card: { id: "card-abc" }, list: { name: "Active" } } },
      sender,
    );
    expect(res).toMatchObject({ status: "signalled", workflowId: "wf-123", signal: "wz.approved" });
    expect(sender.signalWorkflow).toHaveBeenCalledWith(
      "wf-123",
      "wz.approved",
      expect.objectContaining({ actor_id: "kan" }),
    );
  });

  it("ignores non card.moved events", async () => {
    const sender = senderSpy();
    const res = await handleCardMove(db, { event: "card.created" }, sender);
    expect(res.status).toBe("ignored");
    expect(sender.signalWorkflow).not.toHaveBeenCalled();
  });

  it("ignores a card that is not linked to a workflow", async () => {
    mockGetLink.mockResolvedValue(null);
    const sender = senderSpy();
    const res = await handleCardMove(
      db,
      { event: "card.moved", data: { card: { id: "unknown" }, list: { name: "Active" } } },
      sender,
    );
    expect(res.status).toBe("ignored");
    expect(sender.signalWorkflow).not.toHaveBeenCalled();
  });

  it("ignores a move to a list with no mapped signal", async () => {
    mockGetLink.mockResolvedValue({
      workflowId: "wf-123",
      workflowType: "WatchZoneLifecycleWorkflow",
      boardSlug: "wz-lifecycle",
    });
    const sender = senderSpy();
    const res = await handleCardMove(
      db,
      { event: "card.moved", data: { card: { id: "card-abc" }, list: { name: "Proposed" } } },
      sender,
    );
    expect(res.status).toBe("ignored");
    expect(sender.signalWorkflow).not.toHaveBeenCalled();
  });
});
