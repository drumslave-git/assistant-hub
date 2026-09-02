import "server-only";

import {
  WEB_CHAT_SOURCE,
  parseScopedRef,
  scopedRef,
  type OperatorChat,
  type OperatorChatMember,
  type OperatorUser,
  type SourceId,
} from "@assistant-hub-swarm/contracts";

import { ApiError, isApiError } from "@/lib/api-error";

import { webChatDirectoryClient } from "@/features/web-chat/server/directory";
import { sourceDirectoryClient } from "@/server/source-store/directory-client";
import { listCompatibleTransports } from "@/server/transports/service";

import type { SourceDirectoryClient } from "./operator-client";

/**
 * The aggregated directory — the dashboard's one read of "who has talked to
 * this hub, and where" (PLAN.md: "The dashboard aggregates users/chats via a
 * shared listing/CRUD contract each source app's operator API implements").
 *
 * Every source serves the same operator listing contract, so aggregating is a
 * fan-out plus a scoped ref per row: nothing here knows what Telegram is. The
 * web chat's entry answers in-process since the Phase 6 dissolve; tg's is
 * still the HTTP client — the contract doesn't care.
 *
 * A source that is unconfigured or unreachable does NOT fail the read: it
 * comes back under `unavailable` with its reason, so the page renders the
 * sources that answered and says plainly which one it could not reach. A
 * silent empty list would read as "nobody has messaged the bot".
 */

export interface DirectorySource {
  id: SourceId;
  label: string;
  /** The client, or null when this source is not configured in this deployment. */
  client: () => SourceDirectoryClient | null;
}

/**
 * The sources this deployment runs, in the order the dashboard lists them:
 * every transport registered on this core's contract major (labelled with
 * the name it announced), then the web chat. Read from the registration
 * table per call — a transport that came up a minute ago is listed without
 * any core change. Every entry answers from the core's own tables since
 * Phase 7 — same contract, no HTTP, never unconfigured.
 */
export async function directorySources(): Promise<DirectorySource[]> {
  const transports = await listCompatibleTransports();
  return [
    ...transports.map((row) => ({
      id: row.id,
      label: row.name,
      client: () => sourceDirectoryClient(row.id),
    })),
    { id: WEB_CHAT_SOURCE, label: "Web chat", client: webChatDirectoryClient },
  ];
}

/** Human labels of every source keyed by id — resolve once, label many refs. */
export async function sourceLabels(): Promise<Map<string, string>> {
  return new Map((await directorySources()).map((source) => [source.id, source.label]));
}

/** A source's label from a resolved map; an id nothing registered reads as itself. */
export function sourceLabelOf(labels: ReadonlyMap<string, string>, source: SourceId): string {
  return labels.get(source) ?? source;
}

/** One source's label, for the single-ref reads. */
export async function sourceLabel(source: SourceId): Promise<string> {
  return sourceLabelOf(await sourceLabels(), source);
}

/** Where a directory row came from, carried on every entry. */
export interface DirectoryOrigin {
  source: SourceId;
  /** Human name of the source app ("Telegram"), for the listing's column. */
  sourceLabel: string;
  /** Scoped ref of this entity (`tg:user:123`) — how everything else names it. */
  ref: string;
}

export type DirectoryUser = OperatorUser & DirectoryOrigin;
export type DirectoryChat = OperatorChat & DirectoryOrigin;
export type DirectoryChatMember = OperatorChatMember & DirectoryOrigin;

/** A source the listing could not read, and why. */
export interface UnavailableSource {
  source: SourceId;
  sourceLabel: string;
  reason: string;
}

/** A fan-out read: what answered, plus what did not. */
export interface DirectoryListing<T> {
  entries: T[];
  unavailable: UnavailableSource[];
}

function reasonFor(source: DirectorySource, err: unknown): string {
  if (isApiError(err)) return err.message;
  return `${source.label} service unreachable: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Read one listing from every registered source and tag each row with its
 * origin. Sources are read concurrently; each one's failure is isolated.
 */
async function aggregate<Row, Out>(
  sources: readonly DirectorySource[],
  read: (client: SourceDirectoryClient) => Promise<Row[]>,
  tag: (row: Row, origin: DirectoryOrigin) => Out,
  refKind: "user" | "chat",
  refIdOf: (row: Row) => string,
): Promise<DirectoryListing<Out>> {
  const entries: Out[] = [];
  const unavailable: UnavailableSource[] = [];

  const results = await Promise.all(
    sources.map(async (source) => {
      const client = source.client();
      if (!client) {
        return {
          ok: false as const,
          source,
          error: `${source.label} service is not configured (TG_API_URL / INTERNAL_API_TOKEN)`,
        };
      }
      try {
        return { ok: true as const, source, rows: await read(client) };
      } catch (err) {
        return { ok: false as const, source, error: reasonFor(source, err) };
      }
    }),
  );

  for (const result of results) {
    if (!result.ok) {
      unavailable.push({
        source: result.source.id,
        sourceLabel: result.source.label,
        reason: result.error,
      });
      continue;
    }
    for (const row of result.rows) {
      entries.push(
        tag(row, {
          source: result.source.id,
          sourceLabel: result.source.label,
          ref: scopedRef(result.source.id, refKind, refIdOf(row)),
        }),
      );
    }
  }
  return { entries, unavailable };
}

/** Every person every source knows, newest activity first. */
export async function listDirectoryUsers(
  sources?: readonly DirectorySource[],
): Promise<DirectoryListing<DirectoryUser>> {
  const listing = await aggregate<OperatorUser, DirectoryUser>(
    sources ?? (await directorySources()),
    (client) => client.listUsers(),
    (row, origin) => ({ ...row, ...origin }),
    "user",
    (row) => row.id,
  );
  listing.entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return listing;
}

/** Every conversation every source carries, newest activity first. */
export async function listDirectoryChats(
  sources?: readonly DirectorySource[],
): Promise<DirectoryListing<DirectoryChat>> {
  const listing = await aggregate<OperatorChat, DirectoryChat>(
    sources ?? (await directorySources()),
    (client) => client.listChats(),
    (row, origin) => ({ ...row, ...origin }),
    "chat",
    (row) => row.id,
  );
  listing.entries.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
  return listing;
}

/** The source that owns a scoped ref, or a legible 503 when it cannot be reached. */
export async function requireDirectorySource(
  source: SourceId,
  action: string,
): Promise<SourceDirectoryClient> {
  const registered = (await directorySources()).find((entry) => entry.id === source);
  if (!registered) {
    throw ApiError.badRequest(`unknown source "${source}" — ${action}`);
  }
  const client = registered.client();
  if (!client) {
    throw ApiError.serviceUnavailable(
      `${registered.label} service is not configured — ${action}`,
    );
  }
  return client;
}

/** One conversation by scoped ref, tagged with its origin, or null. */
export async function getDirectoryChat(chatRef: string): Promise<DirectoryChat | null> {
  const { source, id } = parseScopedRef(chatRef);
  const client = await requireDirectorySource(source, "the chat cannot be read");
  const chat = await client.getChat(id);
  if (!chat) return null;
  return { ...chat, source, sourceLabel: await sourceLabel(source), ref: chatRef };
}

/**
 * One chat's roster, tagged with its origin. Read from the chat's own source
 * (a ref names it), so the dashboard shows the same participants the source
 * injects into that chat's turns.
 */
export async function listDirectoryChatMembers(chatRef: string): Promise<DirectoryChatMember[]> {
  const { source, id } = parseScopedRef(chatRef);
  const client = await requireDirectorySource(source, "the members cannot be read");
  const members = await client.listChatMembers(id);
  const label = await sourceLabel(source);
  return members.map((member) => ({
    ...member,
    source,
    sourceLabel: label,
    ref: scopedRef(source, "user", member.id),
  }));
}

/**
 * The source write behind a curated directory edit (aliases, languages,
 * group notes). The source owns its directory since the split, so the edit
 * lands there FIRST and a failure surfaces to the caller — an edit that did
 * not reach the authority must not pretend by updating only the local
 * shadow (the next inbound event would overwrite it with the source's old
 * value). The ref names which source to write.
 */
export async function writeSourceUser(
  userRef: string,
  input: { aliases: string[] } | { language: string | null },
): Promise<void> {
  const { source, id } = parseScopedRef(userRef);
  const client = await requireDirectorySource(source, "the edit cannot be saved");
  await client.updateUser(id, input);
}

/** Chat sibling of {@link writeSourceUser}. */
export async function writeSourceChat(
  chatRef: string,
  input: { notes: string | null } | { language: string | null },
): Promise<void> {
  const { source, id } = parseScopedRef(chatRef);
  const client = await requireDirectorySource(source, "the edit cannot be saved");
  await client.updateChat(id, input);
}
