import { describe, expect, it } from "vitest";

import { maintenancePolicy, openPolicy } from "@/test/__mocks__/policy";
import { checkMaintenance } from "./policy";

describe("checkMaintenance", () => {
  it("never blocks when maintenance is off", () => {
    expect(checkMaintenance({ policy: openPolicy, owner: false })).toEqual({ blocked: false });
  });

  it("blocks non-owners when maintenance is on", () => {
    expect(checkMaintenance({ policy: maintenancePolicy, owner: false })).toEqual({
      blocked: true,
      reason: "not_owner",
    });
  });

  it("lets the owner through with no extra restriction (fully functional)", () => {
    expect(checkMaintenance({ policy: maintenancePolicy, owner: true })).toEqual({
      blocked: false,
    });
  });
});
