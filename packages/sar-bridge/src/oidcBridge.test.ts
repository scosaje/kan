import { describe, expect, it } from "vitest";

import { mapMandateRolesToKan } from "./oidcBridge";

describe("mapMandateRolesToKan", () => {
  it("returns admin when any bundle is an admin role", () => {
    expect(mapMandateRolesToKan(["Watch-Zone-Designator", "Watch-Zone-Approver"])).toBe("admin");
    expect(mapMandateRolesToKan(["Field-Team-Dispatcher"])).toBe("admin");
  });

  it("returns member when only member roles are present", () => {
    expect(mapMandateRolesToKan(["Watch-Zone-Designator"])).toBe("member");
    expect(mapMandateRolesToKan(["SAR-Tasking-Operator"])).toBe("member");
  });

  it("ignores unknown roles and returns null when none map", () => {
    expect(mapMandateRolesToKan(["Some-Other-Role"])).toBeNull();
    expect(mapMandateRolesToKan([])).toBeNull();
  });
});
