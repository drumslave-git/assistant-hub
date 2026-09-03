import type {
  Addressing,
  ConnectionIdentity,
  TransportConfigField,
  TransportMedia,
  TransportUser,
} from "@assistant-hub-swarm/contracts";

/**
 * What a transport must supply, and nothing more.
 *
 * The runtime in this package owns everything that is the same for every
 * platform — registering, reconciling, deduping, assembling events,
 * publishing them, consuming deliveries, splitting and sending, the HTTP
 * surface, the MCP delivery tools, boot and shutdown. A transport supplies
 * four things: a {@link TransportDescriptor} saying who it is, a
 * {@link PlatformAdapter} that knows its platform's API, a normalizer that
 * turns one platform message into an {@link InboundMessage}, and the
 * structural {@link AddressingRule}.
 *
 * The division is deliberate: everything here is judgement about a PLATFORM,
 * and everything the runtime keeps is judgement about the CONTRACT. If you
 * find yourself writing contract logic in a transport, that is a gap in this
 * package — the second transport existing is what made the gap visible.
 */

/** Who this transport is, as announced at registration. */
export interface TransportDescriptor {
  /** The source id: a short lowercase slug, the prefix of every scoped ref. */
  id: string;
  /** What the dashboard calls it. */
  name: string;
  /** The fields the assistant editor renders for one connection. */
  connectionConfigSchema: TransportConfigField[];
  /** Transport-wide settings, usually none. */
  transportConfigSchema?: TransportConfigField[];
  /** Where this service serves MCP, or null when it hosts no tools. */
  mcpPath?: string | null;
  /** The platform's message length cap, in UTF-16 code units. */
  maxMessageLength: number;
  /** How often to refresh the typing indicator; the platform decides. */
  typingRefreshMs: number;
}

/** The bot account one connection runs as. */
export interface BotIdentity {
  /** The bot's platform id, verbatim — never parsed. */
  id: string;
  identity: ConnectionIdentity;
}

/**
 * One inbound message in the contract's vocabulary, with the platform's
 * wire format already read off. The runtime turns this into the event.
 */
export interface InboundMessage {
  chatId: string;
  /** A direct conversation (per-assistant stream) or a shared one. */
  direct: boolean;
  chatTitle?: string | null;
  /** The platform's own name for the chat kind, when it has one. */
  chatType?: string | null;
  sourceMessageId: string;
  /** The text the model reads: message text, caption, or a media note. */
  content: string;
  sentAt: string;
  threadId?: string | null;
  sender: TransportUser;
  replyTo?: {
    sourceMessageId: string;
    hasMedia: boolean;
    text: string | null;
    quote?: string | null;
    author: TransportUser | null;
    /** Set when the quoted message was written by one of this deployment's bots. */
    authorPlatformId?: string | null;
  } | null;
  media?: TransportMedia | null;
}

/**
 * The structural addressing verdict for one receiving bot, computed from the
 * platform's own wire shape. Called once per running connection.
 */
export type AddressingRule<TRaw> = (raw: TRaw, bot: BotIdentity) => Addressing;

/** Turn one platform message into the contract's shape. Media included. */
export type Normalizer<TRaw> = (raw: TRaw) => Promise<InboundMessage | null>;

/** What a delivered message looks like, whatever the platform. */
export interface SentMessage {
  sourceMessageId: string;
  /** What the platform actually attached, which is not always what was asked. */
  replyToSourceMessageId: string | null;
}

/** Options every send accepts; a platform ignores what it does not have. */
export interface SendOptions {
  replyToSourceMessageId?: string | null;
  threadId?: string | null;
  silent?: boolean;
  /** Ids the platform may render as links, resolved by the core. */
  linkableSourceMessageIds?: readonly string[];
}

/** A plain button grid; the platform renders it however it can. */
export type MenuGrid = { text: string; callbackData: string }[][];

/**
 * One live connection to the platform: what the runtime can ask it to do.
 * Everything here is an ACTION — the events flow the other way, through the
 * hooks passed to {@link PlatformAdapter.connect}.
 *
 * A platform that lacks an action leaves the method undefined rather than
 * implementing a refusal: the runtime then serves no route and offers no
 * tool for it, which is what "no capability flags" means in practice.
 */
export interface PlatformConnection {
  /** Who this connection is on the platform; known once it is ready. */
  identity(): BotIdentity | null;
  sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<SentMessage>;
  sendVoice?(
    chatId: string,
    voice: { base64: string; filename: string; text: string },
    opts?: SendOptions,
  ): Promise<{ sourceMessageId: string; asVoice: boolean }>;
  sendPhoto?(
    chatId: string,
    image: { base64: string; filename: string },
    opts?: SendOptions,
  ): Promise<{ sourceMessageId: string; mediaId?: string | null }>;
  sendFile?(
    chatId: string,
    file: { base64: string; filename: string; mime?: string | null },
    opts?: SendOptions & { caption?: string | null },
  ): Promise<{ sourceMessageId: string }>;
  deleteMessage?(chatId: string, sourceMessageId: string): Promise<void>;
  sendMenu?(
    chatId: string,
    menu: { text: string; keyboard: MenuGrid; replyToSourceMessageId: string },
  ): Promise<{ sourceMessageId: string }>;
  editMenu?(
    chatId: string,
    sourceMessageId: string,
    menu: { text: string; keyboard: MenuGrid | null },
  ): Promise<void>;
  /**
   * Set (or, with a null emoji, clear) this bot's one reaction badge.
   * `options` carries whatever the platform's own tool offers on top —
   * Telegram's big animated variant, say — and a platform with none ignores it.
   */
  setReaction?(
    chatId: string,
    sourceMessageId: string,
    emoji: string | null,
    options?: Record<string, unknown>,
  ): Promise<void>;
  setChatTitle?(chatId: string, title: string): Promise<{ title: string }>;
  sendTyping?(chatId: string, threadId?: string | null): void;
  /** Whether a chat is a direct one; the core's refs do not carry the kind. */
  isDirectChat(chatId: string): Promise<boolean>;
  close(): Promise<void>;
}

/** How a connection reports what happened, back into the runtime. */
export interface PlatformHooks<TRaw> {
  /** A message arrived. The runtime normalizes, dedupes and forwards it. */
  message(raw: TRaw): void;
  /** A message's text changed. */
  edited(input: {
    chatId: string;
    direct: boolean;
    sourceMessageId: string;
    content: string;
    editedAt: string;
  }): void;
  /** Someone reacted to one of this assistant's messages. */
  reaction(input: {
    chatId: string;
    direct: boolean;
    sourceMessageId: string;
    reaction: "up" | "down";
    user: TransportUser;
  }): void;
  /** A feedback-menu button was pressed; the answer is the toast to show. */
  menuPress(input: {
    chatId: string;
    direct: boolean;
    menuSourceMessageId: string;
    data: string;
    user: TransportUser;
  }): Promise<{ toast: string | null }>;
  /** The connection's state changed (ready, failed, reconnecting). */
  status(input: { state: "running" | "error"; error?: string | null }): void;
}

/** Everything the platform layer is: how to open one connection. */
export interface PlatformAdapter<TRaw> {
  /**
   * Open a connection for one assistant. Resolve once it is started —
   * "ready" is reported through `hooks.status`, so a platform with a
   * handshake need not block here.
   */
  connect(
    input: { connectionId: string; assistantId: string; config: Record<string, unknown> },
    hooks: PlatformHooks<TRaw>,
  ): Promise<PlatformConnection>;
  /** The platform's own words for a failure, for relaying to the core. */
  errorText?(err: unknown): string;
}

/** What a connection is doing, as `/health` and the dashboard report it. */
export interface ConnectionStatus {
  connectionId: string;
  assistantId: string;
  state: "starting" | "running" | "stopped" | "error";
  username: string | null;
  since: string | null;
  error: string | null;
}
