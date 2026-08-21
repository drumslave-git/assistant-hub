"use client";

import { useCallback, useEffect, useState } from "react";

import { useLiveEvent } from "@/components/realtime/useLiveEvent";
import type { ApiErrorBody, ApiOkBody } from "@/lib/api-error";

import type { CardFilters } from "../types";

/**
 * Fetch one analytics card's data for that card's own filters, and keep it live.
 *
 * Every card on the dashboard carries its own period and chat/user scope, so each
 * one reads independently — there is no page-level payload to refresh. That makes
 * three things this hook has to get right, and they are the same three for every
 * card, which is why they live here once:
 *
 *  - **Staleness.** Filters change faster than requests return. The in-flight
 *    request is aborted when the filters move, and the stored result is stamped
 *    with the URL that produced it, so a slow early response can never be shown
 *    against later filters.
 *  - **Liveness.** The insight job's completions arrive on the `analytics` SSE
 *    topic; a card re-fetches itself rather than reloading the page.
 *  - **Continuity.** `loading` is *derived* from the stored result not matching the
 *    current URL, which means the previous period's data stays on screen while the
 *    next request is in flight instead of the card blanking on every click.
 */
interface CardState<T> {
  /** The URL this result came from — what makes it identifiable as current or stale. */
  url: string;
  data: T | null;
  error: string | null;
}

export function useCardData<T>(
  endpoint: string,
  filters: CardFilters,
  params: Record<string, string> = {},
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [result, setResult] = useState<CardState<T> | null>(null);
  // Bumped to re-run the effect for an unchanged URL (a live event).
  const [reloadKey, setReloadKey] = useState(0);

  const query = new URLSearchParams({
    unit: filters.unit,
    anchor: filters.anchor,
    ...(filters.chatId ? { chatId: filters.chatId } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...params,
  }).toString();
  const url = `${endpoint}?${query}`;

  useEffect(() => {
    const controller = new AbortController();

    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json()) as ApiOkBody<T> | ApiErrorBody;
        if (!res.ok) {
          setResult({
            url,
            data: null,
            error: (body as ApiErrorBody).error?.message ?? `Request failed (${res.status})`,
          });
          return;
        }
        setResult({ url, data: (body as ApiOkBody<T>).data, error: null });
      })
      .catch((err: unknown) => {
        // An abort is this hook superseding its own request, not a failure.
        if (err instanceof DOMException && err.name === "AbortError") return;
        setResult({ url, data: null, error: "Network error — could not reach the server" });
      });

    return () => controller.abort();
  }, [url, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  useLiveEvent("analytics", reload);

  return {
    data: result?.data ?? null,
    error: result?.url === url ? result.error : null,
    loading: result?.url !== url,
    reload,
  };
}
