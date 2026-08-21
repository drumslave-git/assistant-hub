"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  JsonView,
  allExpanded,
  collapseAllNested,
  darkStyles,
  defaultStyles,
} from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";

import { useIsDark } from "@/components/theme/useIsDark";

/**
 * Above this many characters of serialized payload, the viewer starts collapsed
 * behind a toggle. This is size-driven, not type-driven: a genuinely large body
 * — a full system prompt, a long message history, a big tool response — folds
 * away by default, while short payloads stay inline. Nothing is hidden
 * permanently; one click reveals the full body.
 */
const AUTO_COLLAPSE_CHARS = 1200;

/** Rough serialized size of a payload, used only to pick the collapse default. */
function estimateSize(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

/** Compact human size label for the toggle, e.g. `840 chars` / `3.2k chars`. */
function formatSize(chars: number): string {
  return chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(1)}k chars`;
}

/**
 * Shared JSON viewer for trace payloads and request/response bodies. Collapsible
 * tree (react-json-view-lite — React 19-compatible), theme-aware via {@link
 * useIsDark}. Objects/arrays render as an expandable tree; primitives (e.g. a
 * full message string) render as wrapped text so nothing is ever truncated.
 *
 * Large payloads start collapsed behind a size-labelled toggle (see
 * {@link AUTO_COLLAPSE_CHARS}) so a huge step doesn't dominate the timeline,
 * without hard-coding any particular step as "the big one".
 */
export function JsonBlock({
  value,
  defaultExpanded = false,
}: {
  value: unknown;
  /** Expand all nodes on first render (still collapsible). Collapsed by default. */
  defaultExpanded?: boolean;
}) {
  const dark = useIsDark();
  const size = estimateSize(value);
  const large = size > AUTO_COLLAPSE_CHARS;
  const [open, setOpen] = useState(!large);

  const isTree = typeof value === "object" && value !== null;
  // Keep the library's colours/icons but drop its opaque container background
  // (a jarring solarized panel) so the tree sits flat on the surrounding card.
  const base = dark ? darkStyles : defaultStyles;
  const style = { ...base, container: "whitespace-pre-wrap break-words" };

  const body = (
    <div className="overflow-auto font-mono text-xs leading-relaxed">
      {isTree ? (
        <JsonView
          data={value as object}
          style={style}
          shouldExpandNode={defaultExpanded ? allExpanded : collapseAllNested}
          clickToExpandNode
        />
      ) : (
        <pre className="break-words whitespace-pre-wrap text-foreground/90">
          {value === undefined ? "undefined" : String(value)}
        </pre>
      )}
    </div>
  );

  if (!large) return body;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded text-xs font-medium text-muted hover:text-foreground"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        {open ? "Hide payload" : "Show payload"}
        <span className="font-mono text-faint">· {formatSize(size)}</span>
      </button>
      {open ? <div className="mt-2">{body}</div> : null}
    </div>
  );
}
