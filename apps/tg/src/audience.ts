import type { ConnectionIdentity } from "@assistant-hub/contracts";

import type { TgDb } from "./db";
import { listChatAssistants } from "./store";

/**
 * Who is listening in a chat.
 *
 * Both halves of shared-chat behavior ask the same question and must get the
 * same answer: a human message in a group is a turn for EVERY assistant there
 * (Telegram delivers it to each bot, but only one poller mirrors it — see
 * `inbound.ts`), and an assistant's reply is cross-fed to the others
 * (`cross-feed.ts`). One definition, one place.
 *
 * An assistant is listening when both are true:
 *
 * - the chat's presence rows name it — stamped by its own poller from what
 *   Telegram actually delivered to its bot, so it is evidence rather than
 *   configuration; and
 * - its connection is running right now — a stopped poller has no bot
 *   identity to put on an event and could not deliver an answer either.
 */

/** One running connection: the assistant it serves and its bot account. */
export interface AssistantConnection {
  assistantId: string;
  /** Numeric Telegram id of the bot account serving this assistant. */
  botId: number;
  identity: ConnectionIdentity;
}

/**
 * The assistants listening in one GROUP chat. Direct chats have exactly one
 * bot in them and their caller already holds it, so they never come here.
 */
export async function listeningAssistants(
  db: TgDb,
  chatId: string,
  running: readonly AssistantConnection[],
): Promise<AssistantConnection[]> {
  if (running.length === 0) return [];
  const present = new Set(await listChatAssistants(db, chatId));
  return running.filter((connection) => present.has(connection.assistantId));
}
