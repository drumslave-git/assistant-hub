"use client";

import { Play, Square } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { useLiveEvent } from "@/components/realtime/useLiveEvent";
import {
  fetchConnections,
  patchConnection,
  type ConnectionView,
} from "@/components/transports/api";
import { connectionStatusView } from "@/components/transports/TransportConnectionSection";
import { Badge, Button } from "@/components/ui";

/**
 * Per-connection start/stop controls for one registered transport's pollers, which live
 * in the transport service since the source split — one row per assistant's
 * bot (connections are per assistant since Phase 3; they are created and
 * re-tokened from the assistant editor's transport section). Client
 * Component: writes desired state through the shared transport client, and
 * re-reads on every `status` event so a crash or reconnect shows up without
 * a reload.
 */
export function BotControl({
  transportId,
  initial,
  assistantNames,
  serviceError,
}: {
  /** The registered transport whose connections these are (its source id). */
  transportId: string;
  initial: ConnectionView[];
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
      setConnections(await fetchConnections(transportId));
    } catch {
      // Keep the last known rows; the status card carries reachability errors.
    }
  }, [transportId]);
  useLiveEvent("status", reload);

  async function toggle(connection: ConnectionView) {
    setBusyId(connection.id);
    setError(null);
    try {
      const updated = await patchConnection(transportId, connection.id, {
        enabled: !connection.enabled,
      });
      // The route answers with the run switch alone; the live poller state
      // follows on the transport's next `status` event.
      setConnections((rows) =>
        rows.map((row) => (row.id === updated.id ? { ...row, enabled: updated.enabled } : row)),
      );
      // The server-rendered status cards around this control read the same
      // state — refresh them along with the rows.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — could not reach the server");
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
        const view = connectionStatusView(connection);
        return (
          <div key={connection.id} className="flex flex-wrap items-center gap-3">
            <Badge tone={view.tone} dot>
              {view.label}
            </Badge>
            <span className="text-sm text-foreground">
              {assistantNames[connection.assistantId] ?? connection.assistantId}
            </span>
            <span className="text-sm text-muted">
              {connection.status?.username
                ? `@${connection.status.username}`
                : Object.entries(connection.configPreview)
                    .map(([key, preview]) => `${key} ${preview}`)
                    .join(" · ")}
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
            {view.tone !== "success" && view.detail ? (
              <span className={view.tone === "danger" ? "text-sm text-danger" : "text-sm text-muted"}>
                {view.detail}
              </span>
            ) : null}
          </div>
        );
      })}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
