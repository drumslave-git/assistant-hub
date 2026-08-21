"use client";

import { useState } from "react";

import { cn } from "@/lib/cn";
import type { RealtimeTopic } from "@/lib/realtime";
import { useLiveRefresh } from "./useLiveRefresh";

/**
 * Live-status pill for a Server Component view. Subscribes to the shared SSE
 * stream for `topic` and refreshes the page on matching events; click to pause
 * (e.g. while reading). Shared across every live dashboard surface.
 */
export function LiveIndicator({ topic }: { topic: RealtimeTopic | RealtimeTopic[] }) {
  const [enabled, setEnabled] = useState(true);
  const { connected } = useLiveRefresh(topic, { enabled });
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
