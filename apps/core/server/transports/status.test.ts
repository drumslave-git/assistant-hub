import { describe, expect, it } from "vitest";

import type { TransportConnectionView } from "./service";
import { summarizeTransports, type TransportRoster } from "./status";

/**
 * The one Bot status card summarizes every registered transport — a refused
 * or unreachable transport is an error the card names, never a silent drop,
 * and connections of different platforms rank the same way.
 */

function connection(overrides: Partial<TransportConnectionView> = {}): TransportConnectionView {
  return {
    id: "c1",
    assistantId: "a1",
    enabled: true,
    configPreview: { botToken: "…1234" },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    status: { state: "running", username: "hub_bot", since: "2026-09-01T00:00:00.000Z", error: null },
    ...overrides,
  };
}

function roster(overrides: Partial<TransportRoster> = {}): TransportRoster {
  return { id: "signal", name: "Signal", refusedReason: null, connections: [], error: null, ...overrides };
}

describe("summarizeTransports", () => {
  it("is unconfigured with no transports and stopped once a connection exists", () => {
    expect(summarizeTransports([])).toEqual({
      status: { state: "stopped", username: null, since: null, error: null },
      configured: false,
    });
    expect(
      summarizeTransports([roster({ connections: [connection({ enabled: false, status: null })] })])
        .configured,
    ).toBe(true);
  });

  it("names the one running bot, and only counts when several are up across transports", () => {
    const one = summarizeTransports([roster({ connections: [connection()] })]);
    expect(one.status).toMatchObject({ state: "running", username: "hub_bot" });

    const two = summarizeTransports([
      roster({ connections: [connection()] }),
      roster({
        id: "discord",
        name: "Discord",
        connections: [connection({ id: "c2", status: { state: "running", username: "other", since: null, error: null } })],
      }),
    ]);
    expect(two.status).toEqual({ state: "running", username: null, since: null, error: null });
  });

  it("reports a refused transport before anything else", () => {
    const summary = summarizeTransports([
      roster({ connections: [connection()] }),
      roster({ id: "discord", name: "Discord", refusedReason: "Discord speaks contract major 2" }),
    ]);
    expect(summary.status).toMatchObject({ state: "error", error: "Discord speaks contract major 2" });
    expect(summary.configured).toBe(true);
  });

  it("names the transport whose enabled connection has no tracked poller", () => {
    const summary = summarizeTransports([
      roster({ connections: [connection({ status: null })] }),
    ]);
    expect(summary.status.state).toBe("error");
    expect(summary.status.error).toBe(
      "connection is enabled but no poller is tracked — is the Signal transport running?",
    );
  });

  it("labels a failing connection by transport and masked config when it has no handle", () => {
    const summary = summarizeTransports([
      roster({
        connections: [
          connection(),
          connection({
            id: "c2",
            configPreview: { phoneNumber: "+1…89" },
            status: { state: "error", username: null, since: null, error: "unauthorized" },
          }),
        ],
      }),
    ]);
    expect(summary.status.error).toBe("Signal phoneNumber +1…89: unauthorized");
  });

  it("surfaces a transport whose listing failed", () => {
    const summary = summarizeTransports([roster({ error: "health probe timed out" })]);
    expect(summary.status).toMatchObject({ state: "error", error: "Signal: health probe timed out" });
    expect(summary.configured).toBe(false);
  });
});
