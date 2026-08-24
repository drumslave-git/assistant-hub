import { describe, expect, it } from "vitest";

import type { OperatorConnection } from "@assistant-hub/contracts";

import { summarizeConnections } from "./tg-operator";

/** A connection row as the tg operator API lists it. Synthetic ids only. */
function connection(input: {
  id: string;
  enabled?: boolean;
  status?: OperatorConnection["status"];
}): OperatorConnection {
  return {
    id: input.id,
    assistantId: `assistant-${input.id}`,
    enabled: input.enabled ?? true,
    botTokenHint: "cdef",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    status: input.status ?? null,
  };
}

const running = (username: string, since = "2026-08-24T10:00:00.000Z") =>
  ({ state: "running", username, since, error: null }) as const;

describe("summarizeConnections", () => {
  it("no connections → stopped and unconfigured", () => {
    expect(summarizeConnections([])).toEqual({
      status: { state: "stopped", username: null, since: null, error: null },
      configured: false,
    });
  });

  it("one running bot keeps its identity", () => {
    const result = summarizeConnections([
      connection({ id: "a", status: running("fixture_bot") }),
    ]);
    expect(result.configured).toBe(true);
    expect(result.status).toEqual({
      state: "running",
      username: "fixture_bot",
      since: "2026-08-24T10:00:00.000Z",
      error: null,
    });
  });

  it("several running bots have no single identity", () => {
    const result = summarizeConnections([
      connection({ id: "a", status: running("bot_one") }),
      connection({ id: "b", status: running("bot_two") }),
    ]);
    expect(result.status.state).toBe("running");
    expect(result.status.username).toBeNull();
    expect(result.status.since).toBeNull();
  });

  it("a disabled connection is stopped but configured", () => {
    const result = summarizeConnections([connection({ id: "a", enabled: false })]);
    expect(result).toEqual({
      status: { state: "stopped", username: null, since: null, error: null },
      configured: true,
    });
  });

  it("an error wins over a running sibling, prefixed with the failing bot", () => {
    const result = summarizeConnections([
      connection({ id: "a", status: running("bot_one") }),
      connection({
        id: "b",
        status: { state: "error", username: "bot_two", since: null, error: "401 unauthorized" },
      }),
    ]);
    expect(result.status.state).toBe("error");
    expect(result.status.error).toBe("@bot_two: 401 unauthorized");
  });

  it("a lone failing connection carries its message unprefixed", () => {
    const result = summarizeConnections([
      connection({
        id: "a",
        status: { state: "error", username: null, since: null, error: "network is down" },
      }),
    ]);
    expect(result.status.error).toBe("network is down");
  });

  it("enabled with no tracked poller reads as an error, not a green light", () => {
    const result = summarizeConnections([connection({ id: "a", status: null })]);
    expect(result.status.state).toBe("error");
    expect(result.status.error).toMatch(/no poller is tracked/);
  });
});
