"use client";

import type { RealtimeEvent } from "@/lib/realtime";

/**
 * The tab's single connection to the shared realtime stream.
 *
 * `/api/events` is designed as **one long-lived connection per tab carrying every
 * topic**, with clients filtering on the payload. That is not just tidiness: a
 * browser allows only ~6 concurrent connections per origin over HTTP/1.1, so a page
 * whose components each opened their own `EventSource` would spend its whole
 * connection budget on streams that never close — and then hang, because there is
 * nothing left to fetch with. A dashboard with eight self-fetching cards reaches
 * that limit on its own.
 *
 * So the stream is a module-level singleton, reference-counted: it opens when the
 * first subscriber arrives and closes when the last one leaves. Components do not
 * touch it directly — they use `useLiveEvent`/`useLiveRefresh`.
 */

export interface RealtimeSubscriber {
  onEvent: (event: RealtimeEvent) => void;
  onConnectionChange: (connected: boolean) => void;
}

const subscribers = new Set<RealtimeSubscriber>();
let source: EventSource | null = null;
let connected = false;

function setConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  for (const subscriber of subscribers) subscriber.onConnectionChange(next);
}

function open(): void {
  if (source) return;
  const stream = new EventSource("/api/events");
  source = stream;

  stream.onopen = () => setConnected(true);
  stream.onerror = () => setConnected(false); // EventSource retries on its own
  stream.onmessage = (message) => {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(message.data) as RealtimeEvent;
    } catch {
      return;
    }
    // A copy: a subscriber may unsubscribe while being notified.
    for (const subscriber of [...subscribers]) subscriber.onEvent(event);
  };
}

function close(): void {
  source?.close();
  source = null;
  connected = false;
}

/** Attach to the tab's stream, opening it if this is the first subscriber. */
export function subscribeToRealtime(subscriber: RealtimeSubscriber): () => void {
  subscribers.add(subscriber);
  open();
  // A late subscriber joining an already-open stream would otherwise not learn it
  // is connected until the next reconnect.
  subscriber.onConnectionChange(connected);

  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) close();
  };
}
