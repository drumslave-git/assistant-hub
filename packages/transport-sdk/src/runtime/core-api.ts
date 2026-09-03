import {
  CONTRACT_MAJOR,
  transportCallbackResponseSchema,
  transportDesiredStateSchema,
  transportMessageLookupResponseSchema,
  type TransportCallbackRequest,
  type TransportDesiredState,
  type TransportMessageLookupResponse,
} from "@assistant-hub-swarm/contracts";

import { INTERNAL_TOKEN_HEADER } from "@assistant-hub-swarm/service";

import type { TransportDescriptor } from "./types";

/**
 * Everything a transport says TO the core: registration and the desired
 * state, the mirror lookup a reaction tool needs, and the toast a menu press
 * wants back. Every transport did this identically, so it lives here once.
 */

const REGISTER_RETRY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface CoreApi {
  /** Register; the answer IS the desired state, so this doubles as the fetch. */
  register(): Promise<TransportDesiredState>;
  /** Register, retrying until the core answers — it may boot second. */
  registerUntilAccepted(): Promise<TransportDesiredState>;
  /** Refetch the desired state, on a config-changed event. */
  desiredState(): Promise<TransportDesiredState>;
  /** Ask the core's mirror about one message (the reaction tool's pre-check). */
  lookupMessage(params: {
    chatId: string;
    sourceMessageId: string;
    assistantId: string | null;
    direct: boolean;
  }): Promise<TransportMessageLookupResponse>;
  /** Forward a menu press and get the toast to answer with. */
  forwardMenuPress(body: TransportCallbackRequest): Promise<{ toast: string | null }>;
}

export function createCoreApi(input: {
  descriptor: TransportDescriptor;
  baseUrl: string;
  token: string;
  /** The base URL this transport announces — what the core calls back. */
  selfUrl: string;
  onRetry?: (message: string) => void;
}): CoreApi {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const onRetry = input.onRetry ?? ((message: string) => console.warn(message));

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        [INTERNAL_TOKEN_HEADER]: input.token,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      // A 409 is the contract-major handshake refusing this build by name.
      // It reads like any other failure here and is retried the same way,
      // because the fix is an operator updating one side or the other.
      throw new Error(body?.error?.message ?? `core ${path} answered ${res.status}`);
    }
    return res.json();
  }

  const register = async (): Promise<TransportDesiredState> =>
    transportDesiredStateSchema.parse(
      await request("/api/internal/transports/register", {
        method: "POST",
        body: JSON.stringify({
          id: input.descriptor.id,
          name: input.descriptor.name,
          contractMajor: CONTRACT_MAJOR,
          baseUrl: input.selfUrl.replace(/\/$/, ""),
          mcpPath: input.descriptor.mcpPath ?? null,
          connectionConfigSchema: input.descriptor.connectionConfigSchema,
          transportConfigSchema: input.descriptor.transportConfigSchema ?? [],
        }),
      }),
    );

  return {
    register,

    async registerUntilAccepted() {
      for (;;) {
        try {
          return await register();
        } catch (err) {
          onRetry(
            `registration with the core failed (${err instanceof Error ? err.message : String(err)}) — ` +
              `retrying in ${REGISTER_RETRY_MS / 1000}s`,
          );
          await new Promise((resolve) => setTimeout(resolve, REGISTER_RETRY_MS));
        }
      }
    },

    async desiredState() {
      return transportDesiredStateSchema.parse(
        await request(`/api/internal/transports/${input.descriptor.id}/desired`),
      );
    },

    async lookupMessage(params) {
      const query = new URLSearchParams({
        source: input.descriptor.id,
        chatId: params.chatId,
        sourceMessageId: params.sourceMessageId,
        ...(params.assistantId ? { assistantId: params.assistantId } : {}),
        ...(params.direct ? { direct: "true" } : {}),
      });
      return transportMessageLookupResponseSchema.parse(
        await request(`/api/internal/transports/messages?${query.toString()}`),
      );
    },

    async forwardMenuPress(body) {
      return transportCallbackResponseSchema.parse(
        await request("/api/internal/transports/callback", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },
  };
}
