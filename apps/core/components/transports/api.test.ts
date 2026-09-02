import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createConnection,
  deleteConnection,
  fetchConnections,
  fetchTransports,
  patchConnection,
} from "./api";

/**
 * The transport client is the one place the dashboard spells the
 * `/api/transports/**` routes. These pin the exact URL and method of every
 * call: the Overview's bot control once carried its own copy pointed at
 * `/api/telegram/connections`, which stopped existing with the transport
 * split, and nothing caught it until an operator pressed Stop.
 */

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calledWith(fetchMock: ReturnType<typeof stubFetch>) {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
  return { url, method: init?.method ?? "GET", body: init?.body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transport client", () => {
  it("lists the registered transports", async () => {
    const fetchMock = stubFetch(envelope({ transports: [{ id: "tg", name: "Telegram" }] }));
    const transports = await fetchTransports();
    expect(calledWith(fetchMock)).toMatchObject({ url: "/api/transports", method: "GET" });
    expect(transports.map((t) => t.id)).toEqual(["tg"]);
  });

  it("lists a transport's connections, scoped to an assistant when asked", async () => {
    const fetchMock = stubFetch(envelope({ connections: [{ id: "c1" }] }));
    await fetchConnections("tg", "assistant 1");
    expect(calledWith(fetchMock)).toMatchObject({
      url: "/api/transports/tg/connections?assistantId=assistant%201",
      method: "GET",
    });
  });

  it("lists every connection of a transport when no assistant is given", async () => {
    const fetchMock = stubFetch(envelope({ connections: [] }));
    expect(await fetchConnections("tg")).toEqual([]);
    expect(calledWith(fetchMock).url).toBe("/api/transports/tg/connections");
  });

  it("connects through POST on the transport's collection", async () => {
    const fetchMock = stubFetch(envelope({ connection: { id: "c1", enabled: true } }, 201));
    const created = await createConnection("tg", { assistantId: "a1", config: { botToken: "x" } });
    expect(calledWith(fetchMock)).toMatchObject({
      url: "/api/transports/tg/connections",
      method: "POST",
      body: JSON.stringify({ assistantId: "a1", config: { botToken: "x" } }),
    });
    expect(created?.id).toBe("c1");
  });

  it("starts, stops and re-configures through PATCH on the connection", async () => {
    const fetchMock = stubFetch(envelope({ connection: { id: "c1", enabled: false } }));
    const result = await patchConnection("tg", "c1", { enabled: false });
    expect(calledWith(fetchMock)).toMatchObject({
      url: "/api/transports/tg/connections/c1",
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(result).toEqual({ id: "c1", enabled: false });
  });

  it("disconnects through DELETE on the connection", async () => {
    const fetchMock = stubFetch(envelope({ deleted: true }));
    await deleteConnection("tg", "c1");
    expect(calledWith(fetchMock)).toMatchObject({
      url: "/api/transports/tg/connections/c1",
      method: "DELETE",
    });
  });

  it("surfaces the server's own message on a failed call", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { message: "Unknown connection" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(patchConnection("tg", "missing", { enabled: true })).rejects.toThrow(
      "Unknown connection",
    );
  });
});
