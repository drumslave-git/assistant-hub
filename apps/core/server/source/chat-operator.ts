import "server-only";

import {
  chatPostMessageResponseSchema,
  chatThreadCreatedResponseSchema,
  chatThreadResponseSchema,
  chatThreadsResponseSchema,
  chatUserResponseSchema,
  type ChatThread,
  type ChatThreadMessage,
  type ChatUser,
} from "@assistant-hub/contracts";

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
 * source serves, so this client extends the shared one with what only this
 * app has: threads — the chat experience the dashboard's own chat page
 * drives through the proxy.
 */

export interface ChatOperatorClient extends SourceDirectoryClient {
  /** The operator's own chat user, created on first contact. */
  operatorUser(): Promise<ChatUser>;
  listThreads(): Promise<ChatThread[]>;
  createThread(input: { assistantId: string; name: string }): Promise<ChatThread>;
  getThread(id: string): Promise<{ thread: ChatThread; messages: ChatThreadMessage[] }>;
  renameThread(id: string, name: string): Promise<ChatThread>;
  deleteThread(id: string): Promise<void>;
  /** Post what the human said; the source stores it and starts the turn. */
  postMessage(
    id: string,
    text: string,
  ): Promise<{ message: ChatThreadMessage; correlationId: string | null }>;
}

/** The client, or null when this deployment does not run the chat app. */
export function chatOperatorClient(): ChatOperatorClient | null {
  const resolved = operatorRequester("chat");
  if (!resolved) return null;
  const { request, label } = resolved;
  const threadPath = (id: string) => `/internal/threads/${encodeURIComponent(id)}`;

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
    async postMessage(id, text) {
      return chatPostMessageResponseSchema.parse(
        await request(`${threadPath(id)}/messages`, {
          method: "POST",
          body: JSON.stringify({ text }),
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
): Promise<{ thread: ChatThread; messages: ChatThreadMessage[] }> {
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
  text: string,
): Promise<{ message: ChatThreadMessage; correlationId: string | null }> {
  return requireClient("the message cannot be sent").postMessage(id, text);
}
