"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";

import type { RealtimeTopic } from "@/lib/realtime";

import { useLiveEvent } from "./useLiveEvent";

/**
 * Subscribe a Server Component view to live updates over the shared SSE stream: on
 * any event matching `topic`, the page re-runs its server read and the fresh data
 * streams in, with no client-side data duplication.
 *
 * For a card that fetches its own data on the client, subscribe with
 * {@link useLiveEvent} and re-fetch — `router.refresh()` cannot reach state a
 * `fetch` put in the client.
 *
 * Returns `{ connected }` for a live indicator.
 */
export function useLiveRefresh(
  topic: RealtimeTopic | RealtimeTopic[],
  options: { enabled?: boolean; debounceMs?: number } = {},
): { connected: boolean } {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  return useLiveEvent(topic, refresh, options);
}
