import "server-only";

import {
  chatPostMessageResponseSchema,
  chatThreadCreatedResponseSchema,
  chatThreadResponseSchema,
  chatThreadsResponseSchema,
  chatUserResponseSchema,
  type ChatThread,
  type ChatThreadMessage,
  type ChatThreadTurn,
  type ChatUser,
} from "@assistant-hub/contracts";

import { ApiError } from "@/lib/api-error";

import { sourceApiConfig } from "./internal-client";
import {
  OPERATOR_TIMEOUT_MS,
  createDirectoryClient,
  operatorRequester,
  type SourceDirectoryClient,
} from "./operator-client";

/**
 * The chat source app's operator API, reached from the core's server code.
 *
 * Everything the dashboard's aggregated directory needs is the contract every
 * source serves, so this client extends the shared one with what only this
 * app has: threads — the chat experience the dashboard's own chat page
 * drives through the proxy.
 */

export interface ChatOperatorClient extends SourceDirectoryClient {
  /** The operator's own chat user, created on first contact. */
  operatorUser(): Promise<ChatUser>;
  listThreads(): Promise<ChatThread[]>;
  createThread(input: { assistantId: string; name: string }): Promise<ChatThread>;
  getThread(
    id: string,
  ): Promise<{ thread: ChatThread; messages: ChatThreadMessage[]; turn: ChatThreadTurn | null }>;
  renameThread(id: string, name: string): Promise<ChatThread>;
  deleteThread(id: string): Promise<void>;
  /** The bytes of one stored image, for rendering. Null when it is gone. */
  mediaBytes(id: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | null>;
  /** Post what the human said; the source stores it and starts the turn. */
  postMessage(
    id: string,
    input: {
      text: string;
      image?: { dataBase64: string; mimeType?: string | null };
      audio?: { dataBase64: string; mimeType?: string | null };
    },
  ): Promise<{ message: ChatThreadMessage; correlationId: string | null }>;
}

/** The client, or null when this deployment does not run the chat app. */
export function chatOperatorClient(): ChatOperatorClient | null {
  const resolved = operatorRequester("chat");
  if (!resolved) return null;
  const { request, label } = resolved;
  const threadPath = (id: string) => `/internal/threads/${encodeURIComponent(id)}`;
  // Bytes do not fit the JSON requester: this one hands back the response so
  // the caller can stream it, and null for a 404 (a picture that is gone).
  const requestRaw = async (path: string): Promise<Response | null> => {
    const config = sourceApiConfig("chat");
    if (!config) return null;
    const res = await fetch(`${config.baseUrl}${path}`, {
      headers: { "x-internal-token": config.token },
      signal: AbortSignal.timeout(OPERATOR_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw ApiError.serviceUnavailable(`${label} ${path} answered ${res.status}`);
    return res;
  };

  return {
    ...createDirectoryClient(request, label),
    async operatorUser() {
      const body = chatUserResponseSchema.parse(await request("/internal/operator-user"));
      return body.user;
    },
    async listThreads() {
      const body = chatThreadsResponseSchema.parse(await request("/internal/threads"));
      return body.threads;
    },
    async createThread(input) {
      const body = chatThreadCreatedResponseSchema.parse(
        await request("/internal/threads", { method: "POST", body: JSON.stringify(input) }),
      );
      return body.thread;
    },
    async getThread(id) {
      return chatThreadResponseSchema.parse(await request(threadPath(id)));
    },
    async renameThread(id, name) {
      const body = chatThreadCreatedResponseSchema.parse(
        await request(threadPath(id), { method: "PATCH", body: JSON.stringify({ name }) }),
      );
      return body.thread;
    },
    async deleteThread(id) {
      await request(threadPath(id), { method: "DELETE" });
    },
    async mediaBytes(id) {
      const res = await requestRaw(`/internal/media/${encodeURIComponent(id)}/bytes`);
      if (!res) return null;
      return {
        bytes: await res.arrayBuffer(),
        mimeType: res.headers.get("content-type") ?? "image/jpeg",
      };
    },
    async postMessage(id, input) {
      return chatPostMessageResponseSchema.parse(
        await request(`${threadPath(id)}/messages`, {
          method: "POST",
          body: JSON.stringify(input),
          // An upload is bigger and slower than a listing: it carries bytes
          // and waits on normalization, so it gets the default timeout.
          timeoutMs: undefined,
        }),
      );
    },
  };
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

/** Every thread this app carries, most recent first (as the source sorts). */
export async function listChatThreads(): Promise<ChatThread[]> {
  return requireClient("threads cannot be read").listThreads();
}

/** Start a thread with one assistant, owned by the operator's chat user. */
export async function createChatThread(input: {
  assistantId: string;
  name: string;
}): Promise<ChatThread> {
  return requireClient("a thread cannot be created").createThread(input);
}

/** One thread with its transcript. */
export async function getChatThread(
  id: string,
): Promise<{ thread: ChatThread; messages: ChatThreadMessage[]; turn: ChatThreadTurn | null }> {
  return requireClient("the thread cannot be read").getThread(id);
}

export async function renameChatThread(id: string, name: string): Promise<ChatThread> {
  return requireClient("the thread cannot be renamed").renameThread(id, name);
}

export async function deleteChatThread(id: string): Promise<void> {
  await requireClient("the thread cannot be deleted").deleteThread(id);
}

/** Say something in a thread: the source stores it and starts the turn. */
export async function postChatMessage(
  id: string,
  input: {
    text: string;
    image?: { dataBase64: string; mimeType?: string | null };
    audio?: { dataBase64: string; mimeType?: string | null };
  },
): Promise<{ message: ChatThreadMessage; correlationId: string | null }> {
  return requireClient("the message cannot be sent").postMessage(id, input);
}

/** The bytes of one stored web-chat image, or null when it is gone. */
export async function chatMediaBytes(
  id: string,
): Promise<{ bytes: ArrayBuffer; mimeType: string } | null> {
  return requireClient("the image cannot be read").mediaBytes(id);
}
