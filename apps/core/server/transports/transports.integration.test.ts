import { CONTRACT_MAJOR, type TransportRegistrationRequest } from "@assistant-hub-swarm/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { isApiError } from "@/lib/api-error";
import { startTestStoreDb, type TestStoreDb } from "@/test/store-db";

import {
  desiredTransportState,
  isRegisteredTransport,
  listCompatibleTransports,
  listTransports,
  registerTransport,
  transportCompatible,
} from "./service";

/**
 * Registration is open (user decision, 2026-09-02): a transport the core has
 * never heard of connects by announcing itself — no list in the core to
 * extend. The one gate is the contract major, and a mismatch is refused
 * loudly: the row exists so the roster can say why, but the transport gets
 * no state and its source is not accepted at ingest.
 */

let store: TestStoreDb;

beforeAll(async () => {
  store = await startTestStoreDb();
});

afterAll(async () => {
  await store?.stop();
});

beforeEach(async () => {
  await store.truncate();
});

function registration(overrides: Partial<TransportRegistrationRequest> = {}): TransportRegistrationRequest {
  return {
    id: "signal",
    name: "Signal",
    baseUrl: "http://signal:3220",
    mcpPath: "/mcp",
    contractMajor: CONTRACT_MAJOR,
    connectionConfigSchema: [
      { key: "phoneNumber", label: "Phone number", kind: "text", required: true },
    ],
    transportConfigSchema: [],
    ...overrides,
  };
}

async function refusal(run: () => Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await run();
  } catch (err) {
    if (isApiError(err)) return { status: err.status, message: err.message };
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("transport registration", () => {
  it("accepts a source id the core has never seen and answers its desired state", async () => {
    const desired = await registerTransport(registration(), store.db);
    expect(desired).toEqual({ transport: { enabled: true, config: {} }, connections: [] });

    const rows = await listTransports(store.db);
    expect(rows.map((row) => [row.id, row.name, row.contractMajor])).toEqual([
      ["signal", "Signal", CONTRACT_MAJOR],
    ]);
    expect(await isRegisteredTransport("signal", store.db)).toBe(true);
    expect(await isRegisteredTransport("discord", store.db)).toBe(false);
  });

  it("refuses another contract major by name, keeps the row so the roster shows why", async () => {
    const refused = await refusal(() =>
      registerTransport(registration({ contractMajor: CONTRACT_MAJOR + 1 }), store.db),
    );
    expect(refused.status).toBe(409);
    expect(refused.message).toContain(`contract major ${CONTRACT_MAJOR + 1}`);
    expect(refused.message).toContain(`speaks ${CONTRACT_MAJOR}`);

    const [row] = await listTransports(store.db);
    expect(row.id).toBe("signal");
    expect(transportCompatible(row)).toBe(false);
    expect(await listCompatibleTransports(store.db)).toEqual([]);

    // No state, no ingest, until either side updates.
    expect((await refusal(() => desiredTransportState("signal", store.db))).status).toBe(409);
    expect(await isRegisteredTransport("signal", store.db)).toBe(false);

    // The same transport rebuilt on this core's major heals in place.
    await registerTransport(registration(), store.db);
    expect(await isRegisteredTransport("signal", store.db)).toBe(true);
    expect((await listCompatibleTransports(store.db)).map((r) => r.id)).toEqual(["signal"]);
  });

  it("keeps the admin's decisions across re-registration while the identity follows the code", async () => {
    await registerTransport(registration(), store.db);
    await registerTransport(
      registration({ name: "Signal (beta)", baseUrl: "http://signal:3221" }),
      store.db,
    );
    const [row] = await listTransports(store.db);
    expect(row.name).toBe("Signal (beta)");
    expect(row.baseUrl).toBe("http://signal:3221");
    expect(row.enabled).toBe(true);
  });
});
