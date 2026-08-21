import type { Message, User } from "@grammyjs/types";

import type { HandleOutcome } from "@/features/bot-messaging/server/service";
import { processUpdate, type ProcessOverrides } from "@/server/telegram/process-update";
import type { BotIdentity, IncomingUpdate, ReplyTransport } from "@/server/telegram/transport";

/**
 * Bot-less flow simulator. The Telegram bot is only a source of events and a
 * reply sink, so a flow can be driven end to end without one: build a synthetic
 * update, run it through the real {@link processUpdate} pipeline (remember →
 * mirror → vision → prompt → tools → LLM → trace → deliver), and capture what
 * would have been sent back.
 *
 * Pair with a real DB (Testcontainers, or the configured DATABASE_URL) to
 * exercise the whole runtime. Inject `overrides.generateReply` for deterministic
 * assertions, or omit it to hit the real configured LLM.
 */

const DEFAULT_BOT: BotIdentity = { id: 424_242, username: "SimBot", displayName: "Sim" };

/** A synthetic Telegram sender. `id` is required; the rest default sensibly. */
export interface SimUser {
  id: number;
  isBot?: boolean;
  username?: string;
  firstName?: string;
  lastName?: string;
}

/** A message the current one replies to (resolved by the reply-chain logic). */
export interface SimReplyTo {
  messageId: number;
  from?: SimUser;
  /** Bot's own reply target — set `from` to the bot to simulate replying to it. */
  text?: string;
}

/** Compact description of one incoming message to simulate. */
export interface SimulateInput {
  /** Message text (or caption). Empty is allowed for a media-only turn. */
  text?: string;
  chatId?: number;
  chatType?: "private" | "group" | "supergroup";
  chatTitle?: string;
  messageId?: number;
  from?: SimUser;
  botInfo?: BotIdentity;
  replyTo?: SimReplyTo;
  /** Unix seconds; defaults to now. */
  date?: number;
  threadId?: number;
  /**
   * Bot token behind media file downloads. Media is rarely simulated (there are
   * no real Telegram files), so this defaults to null and media is skipped.
   */
  token?: string | null;
}

/** A photo the pipeline delivered, as captured by the sink. */
export interface SimulatedPhoto {
  base64: string;
  filename: string;
  messageId: number;
}

/** A captured voice bubble (TTS reply). */
export interface SimulatedVoice {
  base64: string;
  filename: string;
  messageId: number;
}

/** What the pipeline produced, captured from the sink. */
export interface SimulateResult {
  outcome: HandleOutcome;
  /** Every reply the pipeline delivered, in order (maintenance notice, reply…). */
  replies: string[];
  /** Every photo the pipeline delivered, in order (generated images). */
  photos: SimulatedPhoto[];
  /** Every voice bubble the pipeline delivered, in order (TTS replies). */
  voices: SimulatedVoice[];
  /** How many times the "typing…" action was requested (initial tick + refreshes). */
  typingCalls: number;
}

function toTelegramUser(user: SimUser): User {
  return {
    id: user.id,
    is_bot: user.isBot ?? false,
    first_name: user.firstName ?? `User${user.id}`,
    ...(user.lastName != null ? { last_name: user.lastName } : {}),
    ...(user.username != null ? { username: user.username } : {}),
  };
}

/** Build a minimal but well-formed Telegram message from the compact input. */
function buildMessage(input: SimulateInput): Message {
  const chatId = input.chatId ?? 555;
  const chatType = input.chatType ?? "private";
  const from = toTelegramUser(input.from ?? { id: 100, username: "tester" });

  const chat =
    chatType === "private"
      ? { id: chatId, type: "private" as const, first_name: from.first_name }
      : { id: chatId, type: chatType, title: input.chatTitle ?? "Test Group" };

  const replyTo: Message | undefined = input.replyTo
    ? ({
        message_id: input.replyTo.messageId,
        date: (input.date ?? Math.floor(Date.now() / 1000)) - 60,
        chat,
        ...(input.replyTo.from ? { from: toTelegramUser(input.replyTo.from) } : {}),
        ...(input.replyTo.text != null ? { text: input.replyTo.text } : {}),
      } as Message)
    : undefined;

  return {
    message_id: input.messageId ?? 1,
    date: input.date ?? Math.floor(Date.now() / 1000),
    chat,
    from,
    text: input.text ?? "",
    ...(input.threadId != null ? { message_thread_id: input.threadId } : {}),
    ...(replyTo ? { reply_to_message: replyTo } : {}),
  } as Message;
}

/**
 * Run one simulated incoming message through the real pipeline. Returns the
 * service outcome plus the captured replies/typing. Provide
 * `overrides.generateReply` for a deterministic reply, or omit to hit the
 * DB-configured LLM.
 */
export async function simulateUpdate(
  input: SimulateInput,
  overrides?: ProcessOverrides,
): Promise<SimulateResult> {
  const replies: string[] = [];
  const photos: SimulatedPhoto[] = [];
  const voices: SimulatedVoice[] = [];
  let typingCalls = 0;
  let nextMessageId = (input.messageId ?? 1) + 1_000;

  const transport: ReplyTransport = {
    async sendReply(text) {
      replies.push(text);
      return { messageId: nextMessageId++ };
    },
    async sendPhoto(image) {
      const messageId = nextMessageId++;
      photos.push({ base64: image.base64, filename: image.filename, messageId });
      // A real send mints a file id; synthesize a stable one so the media row the
      // pipeline stores is keyed exactly as it would be against Telegram.
      return { messageId, fileId: `sim-file-${messageId}`, fileUniqueId: `sim-uniq-${messageId}` };
    },
    async sendVoice(voice) {
      const messageId = nextMessageId++;
      voices.push({ base64: voice.base64, filename: voice.filename, messageId });
      return { messageId };
    },
    sendTyping() {
      typingCalls++;
    },
  };

  const update: IncomingUpdate = {
    message: buildMessage(input),
    botInfo: input.botInfo ?? DEFAULT_BOT,
    resolveToken: async () => input.token ?? null,
  };

  const outcome = await processUpdate(update, transport, overrides);
  return { outcome, replies, photos, voices, typingCalls };
}
