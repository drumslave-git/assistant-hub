import "server-only";

import type { OperatorChat } from "@assistant-hub/contracts";

import { ApiError } from "@/lib/api-error";

import {
  createDirectoryClient,
  operatorRequester,
  type SourceDirectoryClient,
} from "./operator-client";

/**
 * The chat source app's operator API, reached from the core's server code.
 *
 * Everything the dashboard's aggregated directory needs is the contract every
 * source serves, so this app's client IS the shared one — the file exists to
 * name the source and to be where chat's own operator calls (thread CRUD)
 * land in slice B.
 */

export type ChatOperatorClient = SourceDirectoryClient;

/** The client, or null when this deployment does not run the chat app. */
export function chatOperatorClient(): ChatOperatorClient | null {
  const resolved = operatorRequester("chat");
  if (!resolved) return null;
  return createDirectoryClient(resolved.request, resolved.label);
}

/** The client, or a legible 503 naming what is missing. */
function requireClient(action: string): ChatOperatorClient {
  const client = chatOperatorClient();
  if (!client) {
    throw ApiError.serviceUnavailable(
      `web chat service is not configured (CHAT_API_URL / INTERNAL_API_TOKEN) — ${action}`,
    );
  }
  return client;
}

/** Every thread this app carries, newest activity first (as the source sorts). */
export async function listChatThreads(): Promise<OperatorChat[]> {
  return requireClient("threads cannot be read").listChats();
}
