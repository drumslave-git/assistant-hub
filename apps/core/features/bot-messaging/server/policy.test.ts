import { describe, expect, it } from "vitest";

import {
  openPolicy,
  ownerlessMaintenancePolicy,
  ownerMaintenancePolicy,
} from "@/test/__mocks__/policy";
import { checkMaintenance, isOwner } from "./policy";

const OWNER = ownerMaintenancePolicy;

describe("isOwner", () => {
  it("matches the configured owner by numeric id", () => {
    expect(isOwner({ fromId: 42 }, OWNER)).toBe(true);
    expect(isOwner({ fromId: 43 }, OWNER)).toBe(false);
  });

  it("is false when no owner is configured", () => {
    expect(isOwner({ fromId: 1 }, ownerlessMaintenancePolicy)).toBe(false);
  });

  it("is false when the sender has no id", () => {
    expect(isOwner({}, OWNER)).toBe(false);
  });
});

describe("checkMaintenance", () => {
  it("never blocks when maintenance is off", () => {
    expect(checkMaintenance({ policy: openPolicy, owner: false })).toEqual({ blocked: false });
  });

  it("blocks non-owners when maintenance is on", () => {
    expect(checkMaintenance({ policy: OWNER, owner: false })).toEqual({
      blocked: true,
      reason: "not_owner",
    });
  });

  it("lets the owner through with no extra restriction (fully functional)", () => {
    expect(checkMaintenance({ policy: OWNER, owner: true })).toEqual({ blocked: false });
  });
});
