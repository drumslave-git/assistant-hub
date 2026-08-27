"use client";

import { useCallback, useEffect, useState } from "react";
import { MessagesSquare } from "lucide-react";

import type { OperatorChat } from "@assistant-hub/contracts";
import {
  Card,
  EmptyState,
  PageHeader,
  Timestamp,
  apiFetch,
  type AppPageProps,
} from "@assistant-hub/ui";

/**
 * The web-chat page the shell mounts at `/apps/chat` — this app's own view,
 * built from the shared dashboard primitives so it reads like every other
 * page, and fed only through the core proxy (`/api/chat/*`), never by
 * importing this app's server code (PLAN.md, "Dashboard composition").
 *
 * Slice A lists the threads this app carries. Creating a thread, opening one
 * and talking in it arrive with slice B — which is also when `segments` starts
 * carrying a thread id.
 */

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; threads: OperatorChat[] };

export function ChatThreadsPage(_props: AppPageProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ threads: OperatorChat[] }>("/api/chat/threads");
      setState({ kind: "ready", threads: data.threads });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not reach the server",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Web chat"
        description="Threads with your assistants, in the dashboard itself."
      />

      {state.kind === "loading" ? (
        <p className="text-sm text-muted">Loading threads…</p>
      ) : null}

      {state.kind === "error" ? (
        <EmptyState
          icon={MessagesSquare}
          title="The chat service did not answer"
          description={state.message}
        />
      ) : null}

      {state.kind === "ready" && state.threads.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="No threads yet"
          description="Threads you start with an assistant will appear here."
        />
      ) : null}

      {state.kind === "ready" && state.threads.length > 0 ? (
        <ul className="space-y-2">
          {state.threads.map((thread) => (
            <li key={thread.id}>
              <Card className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{thread.title ?? thread.id}</p>
                  <p className="text-xs text-muted">
                    {thread.messageCount} {thread.messageCount === 1 ? "message" : "messages"}
                  </p>
                </div>
                <Timestamp
                  iso={thread.lastMessageAt}
                  className="shrink-0 text-xs text-muted"
                  fallback="no messages yet"
                />
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
