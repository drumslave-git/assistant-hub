"use client";

import { useState } from "react";

import type { RealtimeTopic } from "@assistant-hub/contracts";

import { cn } from "./cn";
import { useLiveEvent } from "./useLiveEvent";

/**
 * Live-status pill: subscribes to the shared SSE stream for `topic`, runs
 * `onEvent` when one arrives, and can be clicked to pause (e.g. while
 * reading). Shared across every live dashboard surface — the shell's own
 * pages hand it a `router.refresh()`, a page that fetched its own data on
 * the client hands it a re-fetch, and neither has to own a subscription.
 */
export function LiveIndicator({
  topic,
  onEvent,
}: {
  topic: RealtimeTopic | RealtimeTopic[];
  onEvent: () => void;
}) {
  const [enabled, setEnabled] = useState(true);
  const { connected } = useLiveEvent(topic, onEvent, { enabled });
  const live = enabled && connected;
  const label = !enabled ? "Paused" : connected ? "Live" : "Connecting…";

  return (
    <button
      type="button"
      onClick={() => setEnabled((v) => !v)}
      aria-pressed={enabled}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors",
        "focus-visible:ring-ring/60 focus-visible:ring-2 focus-visible:outline-none",
        live
          ? "border-success/30 bg-success/10 text-success"
          : "border-border bg-surface-2 text-muted hover:text-foreground",
      )}
      title={enabled ? "Live updates on — click to pause" : "Paused — click to resume"}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full bg-current",
          live && "animate-pulse motion-reduce:animate-none",
        )}
        aria-hidden
      />
      {label}
    </button>
  );
}
