import { describe, expect, it } from "vitest";

import { callKindLabel, callKindOf, LLM_CALL_KINDS } from "./llm-call-kind";

/** Minimal `llm_response` event shape for the classifier. */
function event(message: string, callKind?: string) {
  return { message, usage: callKind ? { callKind } : {} };
}

describe("callKindOf", () => {
  it("trusts the kind recorded at the call site", () => {
    expect(callKindOf({ feature: "bot-messaging", action: "reply" }, event("response", "reply-tool-turn")))
      .toBe("reply-tool-turn");
  });

  it("ignores a recorded kind that is not in the taxonomy", () => {
    // A stale or hand-edited trace must not invent a column on the dashboard.
    expect(callKindOf({ feature: "vision", action: "describe" }, event("response", "made-up")))
      .toBe("vision-describe");
  });

  describe("traces written before the kind was recorded", () => {
    it("separates the addressing check from the reply by its own event message", () => {
      const trace = { feature: "bot-messaging", action: "reply" };
      expect(callKindOf(trace, event("addressing analyzer response"))).toBe("addressing-check");
      expect(callKindOf(trace, event("response"))).toBe("reply-final");
    });

    it("classifies every other feature exactly, since each emits one kind", () => {
      const cases: [string, string][] = [
        ["vision", "vision-describe"],
        ["history-summaries", "history-summarize"],
        ["memory-extraction", "memory-extract"],
        ["memory", "memory-consolidate"],
        ["scheduled-tasks", "scheduled-task-fire"],
        ["self-improvement", "self-improve-analyze"],
        ["user-feedback", "self-improve-reflect"],
      ];
      for (const [feature, expected] of cases) {
        expect(callKindOf({ feature, action: "x" }, event("response"))).toBe(expected);
      }
    });
  });

  it("returns null for an unknown feature rather than inventing a bucket", () => {
    expect(callKindOf({ feature: "something-else", action: "x" }, event("response"))).toBeNull();
  });
});

describe("callKindLabel", () => {
  it("renders a human label for every kind in the taxonomy", () => {
    for (const id of Object.keys(LLM_CALL_KINDS)) {
      expect(callKindLabel(id)).not.toBe(id);
      expect(callKindLabel(id).length).toBeGreaterThan(0);
    }
  });

  it("falls back to the raw id rather than rendering nothing", () => {
    expect(callKindLabel("unknown-kind")).toBe("unknown-kind");
  });
});
