import { afterEach, describe, expect, it, vi } from "vitest";

const info = vi.hoisted(() => ({ current: null as null | Record<string, number> }));

vi.mock("@temporalio/activity", () => ({
  Context: {
    current: () => {
      if (!info.current) throw new Error("not in an activity");
      return { info: info.current };
    },
  },
}));
vi.mock("./config.js", () => ({
  config: { KAN_API_BASE: "http://kan/api/v1", KAN_INTERNAL_EMAIL: "e", KAN_INTERNAL_PASSWORD: "p" },
}));
vi.mock("./log.js", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { KanClient } from "./kanClient.js";

const ok = (body: unknown = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "set-cookie": "kan.session_token=abc" } });

afterEach(() => {
  info.current = null;
  vi.unstubAllGlobals();
});

describe("activity attempt deadline", () => {
  it("refuses a write once the attempt has timed out, but still reads", async () => {
    const fetchMock = vi.fn(async () => ok({ user: { id: "u1" } }));
    vi.stubGlobal("fetch", fetchMock);
    // Scheduled 10 s ago with a 5 s start-to-close: a retry owns the action.
    info.current = { currentAttemptScheduledTimestampMs: Date.now() - 10_000, startToCloseTimeoutMs: 5_000 };
    const kan = new KanClient();

    await expect(kan.request("PUT", "/cards/abc")).rejects.toThrow(/deadline passed/);
    await kan.request("GET", "/cards/abc");
    const paths = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(paths.filter((u) => u.includes("/api/v1/"))).toEqual(["http://kan/api/v1/cards/abc"]);
  });

  it("does not sleep through a 429 past the deadline", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/sign-in/") ? ok({ user: { id: "u1" } })
        : new Response("slow down", { status: 429, headers: { "retry-after": "10" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    info.current = { currentAttemptScheduledTimestampMs: Date.now(), startToCloseTimeoutMs: 5_000 };
    const t0 = Date.now();
    await expect(new KanClient().request("PUT", "/cards/abc")).rejects.toMatchObject({ status: 429 });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
