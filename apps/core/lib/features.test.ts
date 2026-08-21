import { describe, expect, it } from "vitest";

import {
  FEATURE_GROUPS,
  FEATURE_IDS,
  FEATURES,
  featureGroup,
  featureLabel,
  groupedFeatureOptions,
} from "./features";

/**
 * The feature registry's grouping — what the Debug filter renders as optgroups.
 * A flat list of 31 options is what these tests exist to keep from coming back.
 */

describe("FEATURES", () => {
  it("gives every registered feature a known group", () => {
    for (const id of FEATURE_IDS) {
      expect(FEATURE_GROUPS).toContain(FEATURES[id].group);
    }
  });
});

describe("groupedFeatureOptions", () => {
  it("covers every registered feature exactly once, with no empty groups", () => {
    const groups = groupedFeatureOptions();
    const ids = groups.flatMap((group) => group.ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...FEATURE_IDS].sort());
    expect(groups.every((group) => group.ids.length > 0)).toBe(true);
  });

  it("orders groups by the registry order and options by label", () => {
    const groups = groupedFeatureOptions();
    expect(groups[0].label).toBe("Conversation");

    const tools = groups.find((group) => group.label === "Tools");
    const labels = tools!.ids.map(featureLabel);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it("keeps a retired feature that only exists in old traces, under Other", () => {
    // `chat-rules` was absorbed into `tasks`, but its traces are still on disk —
    // dropping it from the filter would make them unreachable.
    const groups = groupedFeatureOptions(["chat-rules"]);
    const other = groups.find((group) => group.label === "Other");
    expect(other?.ids).toContain("chat-rules");
    expect(featureGroup("chat-rules")).toBeNull();
    // "Other" comes last, after every registered group.
    expect(groups.at(-1)?.label).toBe("Other");
  });

  it("includes the active selection even when it is in neither source", () => {
    const groups = groupedFeatureOptions([], "some-unknown-feature");
    expect(groups.flatMap((group) => group.ids)).toContain("some-unknown-feature");
  });

  it("does not duplicate a feature that is both registered and present in the data", () => {
    const ids = groupedFeatureOptions(["tasks"], "tasks").flatMap((group) => group.ids);
    expect(ids.filter((id) => id === "tasks")).toHaveLength(1);
  });
});
