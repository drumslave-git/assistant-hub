"use client";

import { Play, Square } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import type { OperatorConnection } from "@assistant-hub/contracts";

import { useLiveEvent } from "@/components/realtime/useLiveEvent";
import { Badge, Button } from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";

/**
 * Per-connection start/stop controls for the Telegram pollers, which live in
 * the tg source app since the source split — one row per assistant's bot
 * (connections are per assistant since Phase 3; they are created and
 * re-tokened from the assistant editor's tg section). Client Component:
 * writes desired state through the connections proxy, and re-reads on every
 * `status` event so a crash or reconnect shows up without a reload.
 */
export function BotControl({
  initial,
  assistantNames,
  serviceError,
}: {
  initial: OperatorConnection[];
  /** Assistant display names by id, for labelling each row. */
  assistantNames: Record<string, string>;
  /** Why the connection listing failed, when it did (service down/unconfigured). */
  serviceError: string | null;
}) {
  const router = useRouter();
  const [connections, setConnections] = useState(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/telegram/connections");
      if (!res.ok) return;
      const body = (await res.json()) as { data?: { connections: OperatorConnection[] } };
      if (body.data) setConnections(body.data.connections);
    } catch {
      // Keep the last known rows; the status card carries reachability errors.
    }
  }, []);
  useLiveEvent("status", reload);

  async function toggle(connection: OperatorConnection) {
    setBusyId(connection.id);
    setError(null);
    try {
      const res = await fetch(`/api/telegram/connections/${encodeURIComponent(connection.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !connection.enabled }),
      });
      const body = (await res.json()) as {
        data?: { connection: OperatorConnection };
      } & ApiErrorBody;
      if (!res.ok) {
        setError(body.error?.message ?? `Request failed (${res.status})`);
        return;
      }
      if (body.data) {
        const updated = body.data.connection;
        setConnections((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      }
      // The server-rendered status cards around this control read the same
      // state — refresh them along with the rows.
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusyId(null);
    }
  }

  if (serviceError) {
    return <p className="text-sm text-danger">{serviceError}</p>;
  }

  if (connections.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted">
          No bot connections yet — connect a bot to an assistant.
        </span>
        <Button asChild size="sm" variant="outline">
          <Link href="/assistants">Assistants</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {connections.map((connection) => {
        const running = connection.status?.state === "running";
        const failed = connection.status?.state === "error";
        return (
          <div key={connection.id} className="flex flex-wrap items-center gap-3">
            <Badge tone={running ? "success" : failed ? "danger" : "neutral"} dot>
              {running ? "Running" : failed ? "Error" : "Stopped"}
            </Badge>
            <span className="text-sm text-foreground">
              {assistantNames[connection.assistantId] ?? connection.assistantId}
            </span>
            <span className="text-sm text-muted">
              {connection.status?.username
                ? `@${connection.status.username}`
                : `token …${connection.botTokenHint}`}
            </span>
            <Button
              size="sm"
              variant={connection.enabled ? "outline" : "primary"}
              onClick={() => void toggle(connection)}
              disabled={busyId !== null}
              leftIcon={
                connection.enabled ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />
              }
            >
              {busyId === connection.id ? "Working…" : connection.enabled ? "Stop" : "Start"}
            </Button>
            {failed && connection.status?.error ? (
              <span className="text-sm text-danger">{connection.status.error}</span>
            ) : null}
          </div>
        );
      })}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
