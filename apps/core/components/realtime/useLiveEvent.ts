"use client";

import { useEffect, useRef, useState } from "react";

import type { RealtimeTopic } from "@/lib/realtime";

import { subscribeToRealtime } from "./event-stream";

/**
 * Subscribe to the shared realtime stream: invokes `onEvent` (debounced) for every
 * event matching `topic` — a single topic, or any of several (the consolidated Jobs
 * board watches all six job topics at once).
 *
 * Every consumer on a page shares one `EventSource` (see `event-stream`), so it is
 * safe for many components to call this.
 *
 * Two consumers sit on top of it, because a page has two ways of holding data.
 * {@link useLiveRefresh} re-runs a Server Component's read via `router.refresh()`.
 * A card that fetched its own data on the client can't use that — `router.refresh()`
 * re-renders the tree but cannot know about state a `fetch` put in a `useState` —
 * so it passes a re-fetch instead.
 *
 * `enabled=false` detaches. Returns `{ connected }` for a live indicator.
 */
export function useLiveEvent(
  topic: RealtimeTopic | RealtimeTopic[],
  onEvent: () => void,
  { enabled = true, debounceMs = 400 }: { enabled?: boolean; debounceMs?: number } = {},
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The latest handler, held in a ref so a caller passing a fresh closure each
  // render does not re-subscribe. Synced in its own effect — writing a ref during
  // render is not allowed.
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);

  // A stable primitive dep so passing a fresh array literal each render does not
  // re-subscribe either.
  const topicKey = (Array.isArray(topic) ? topic : [topic]).join(",");

  useEffect(() => {
    if (!enabled) return;

    const topics = new Set(topicKey.split(",") as RealtimeTopic[]);
    const unsubscribe = subscribeToRealtime({
      onConnectionChange: setConnected,
      onEvent: (event) => {
        if (!topics.has(event.topic)) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => handler.current(), debounceMs);
      },
    });

    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, topicKey, debounceMs]);

  // Derived rather than stored: a detached consumer is not connected, whatever the
  // shared stream last reported.
  return { connected: enabled && connected };
}
