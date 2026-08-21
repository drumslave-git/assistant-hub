import "server-only";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Bidirectional in-memory MCP transport. A linked pair wires an MCP `Client` to a
 * local `McpServer` inside the same process — no sockets, no HTTP. Messages are
 * delivered on a microtask so `send` never re-enters the caller synchronously.
 */
export class InProcessTransport implements Transport {
  private linked?: InProcessTransport;
  onmessage?: Transport["onmessage"];
  onclose?: () => void;
  onerror?: (error: Error) => void;

  static createLinkedPair(): [InProcessTransport, InProcessTransport] {
    const serverSide = new InProcessTransport();
    const clientSide = new InProcessTransport();
    serverSide.linked = clientSide;
    clientSide.linked = serverSide;
    return [serverSide, clientSide];
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const peer = this.linked;
    if (!peer?.onmessage) {
      throw new Error("InProcessTransport peer is not ready");
    }
    queueMicrotask(() => {
      void peer.onmessage?.(message);
    });
  }
}
