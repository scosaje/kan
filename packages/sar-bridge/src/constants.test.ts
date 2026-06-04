import { describe, expect, it } from "vitest";

import { BOARD_DEFS, SAR_BOARD_SLUGS, SIGNAL_MAP } from "./constants";

describe("constants", () => {
  it("every board key maps to its slug consistently in BOARD_DEFS", () => {
    for (const def of BOARD_DEFS) {
      expect(SAR_BOARD_SLUGS[def.key]).toBe(def.slug);
    }
  });

  it("Phase 1 includes the Watch Zone Lifecycle board with an Active list", () => {
    const wz = BOARD_DEFS.find((d) => d.slug === "wz-lifecycle");
    expect(wz?.phase).toBe(1);
    expect(wz?.lists).toContain("Active");
  });

  it("every SIGNAL_MAP target list exists on its board", () => {
    for (const [slug, moves] of Object.entries(SIGNAL_MAP)) {
      const def = BOARD_DEFS.find((d) => d.slug === slug);
      expect(def, `board ${slug} defined`).toBeTruthy();
      for (const listName of Object.keys(moves)) {
        expect(def?.lists, `${slug} has list ${listName}`).toContain(listName);
      }
    }
  });

  it("moving a watch-zone card to Active signals wz.approved", () => {
    expect(SIGNAL_MAP["wz-lifecycle"]?.Active).toBe("wz.approved");
  });
});
