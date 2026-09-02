import "server-only";

import { WEB_CHAT_SOURCE, type SourceId } from "@assistant-hub-swarm/contracts";

import type { MediaStorePort } from "@/features/vision/server/service";
import type { MediaRecord } from "@/features/vision/server/repository";
import { webChatMediaBrowse, webChatMediaStore } from "@/features/web-chat/server/media-store";
import {
  sourceStoreMediaBrowse,
  sourceStoreMediaPort,
} from "@/server/source-store/media-port";
import { listCompatibleTransports } from "@/server/transports/service";

/**
 * A source's media as the pipeline's {@link MediaStorePort} — in-process for
 * every source since Phase 7. The describe/transcribe features read a
 * pending row's bytes and write the text back; what happens to the bytes is
 * per store (a transport's are dropped once described — the platform is its
 * own archive; a web thread keeps them, it is the only archive its images
 * have).
 */

/**
 * One source's media store — in-process for every source since Phase 7: the
 * web chat's tables (Phase 6) and the transports' conversation store both
 * live here.
 */
export function sourceMediaStore(source: SourceId): MediaStorePort | null {
  if (source === WEB_CHAT_SOURCE) return webChatMediaStore();
  return sourceStoreMediaPort(source);
}

/**
 * What the vision feature needs of a source's media beyond the per-row
 * store: the backfill's work list and the dashboard gallery's recent rows.
 * Every source serves it, so the backfill and the gallery fan out rather
 * than knowing which app has pictures.
 */
export interface SourceMediaBrowse {
  /** Which app this surface reads — rows are tagged with it. */
  source: SourceId;
  store: MediaStorePort;
  listPending(limit: number): Promise<{ id: string; chatId: string; telegramMessageId: number }[]>;
  countPending(): Promise<number>;
  listRecent(limit: number): Promise<MediaRecord[]>;
}

/** One source's browse surface — in-process for every source since Phase 7. */
export function sourceMediaBrowse(source: SourceId): SourceMediaBrowse | null {
  if (source === WEB_CHAT_SOURCE) {
    return { source, store: webChatMediaStore(), ...webChatMediaBrowse };
  }
  return { source, store: sourceStoreMediaPort(source), ...sourceStoreMediaBrowse(source) };
}

/**
 * Every source this deployment runs: the transports registered on this
 * core's contract major, then the web chat. The backfill and the dashboard
 * gallery work across all of them: pictures arrive wherever people are, and
 * neither surface should have to know which app that was — nor does this
 * module: the roster is whatever registered.
 */
export async function mediaSources(): Promise<SourceMediaBrowse[]> {
  const transports = await listCompatibleTransports();
  return [...transports.map((row) => row.id), WEB_CHAT_SOURCE]
    .map((source) => sourceMediaBrowse(source))
    .filter((browse): browse is SourceMediaBrowse => browse !== null);
}
