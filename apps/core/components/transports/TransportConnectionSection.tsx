"use client";

import { useCallback, useEffect, useState } from "react";

import type { TransportConfigField } from "@assistant-hub/contracts";
import { Badge, Button, Field, Input, type BadgeTone } from "@assistant-hub/ui";

import {
  createConnection,
  deleteConnection,
  fetchConnections,
  patchConnection,
  type ConnectionPatch,
  type ConnectionView,
  type TransportSummary,
} from "./api";

/**
 * The assistant editor's transport sections, schema-driven (redesign
 * Phase 7, PLAN.md "Dashboard"): every registered transport contributes a
 * connection section rendered from the config field schema it announced at
 * registration — no build-time UI package, so a new transport gets its
 * dashboard surface for free. Behaviors carried over from the tg app's old
 * hand-written section: connect, replace secrets (write-only), start/stop,
 * disconnect with a confirm, live poller state.
 *
 * Every call goes through the shared transport client (`./api`), which the
 * Overview's bot control shares.
 */

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; connection: ConnectionView | null };

/** The badge and detail one connection's state renders as. */
export function connectionStatusView(connection: Pick<ConnectionView, "enabled" | "status">): {
  tone: BadgeTone;
  label: string;
  detail: string | null;
} {
  const status = connection.status;
  if (status?.state === "running") {
    return {
      tone: "success",
      label: "Running",
      detail: status.username ? `@${status.username} — polling` : "polling",
    };
  }
  if (status?.state === "error") {
    return { tone: "danger", label: "Error", detail: status.error ?? "unknown error" };
  }
  if (connection.enabled) {
    return {
      tone: "warning",
      label: "Not tracked",
      detail: "enabled, but nothing is tracked — is the transport service running?",
    };
  }
  return { tone: "neutral", label: "Stopped", detail: null };
}

const NETWORK_ERROR = "Network error — could not reach the server";

export function TransportConnectionSection({
  transport,
  assistantId,
  refreshSignal,
}: {
  transport: TransportSummary;
  assistantId: string;
  refreshSignal: number;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const load = useCallback(async () => {
    try {
      const connections = await fetchConnections(transport.id, assistantId);
      setState({ kind: "ready", connection: connections[0] ?? null });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : NETWORK_ERROR });
    }
  }, [transport.id, assistantId]);

  useEffect(() => {
    const initial = async () => {
      await load();
    };
    void initial();
  }, [load, refreshSignal]);

  async function mutate(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      setValues({});
      setConfirmingDisconnect(false);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  const filledConfig = (): Record<string, string> => {
    const config: Record<string, string> = {};
    for (const field of transport.connectionConfigSchema) {
      const value = values[field.key]?.trim();
      if (value) config[field.key] = value;
    }
    return config;
  };

  const requiredMissing = transport.connectionConfigSchema.some(
    (field) => field.required && !values[field.key]?.trim(),
  );

  const connect = () =>
    mutate(() => createConnection(transport.id, { assistantId, config: filledConfig() }));

  const patch = (id: string, body: ConnectionPatch) =>
    mutate(() => patchConnection(transport.id, id, body));

  const disconnect = (id: string) => mutate(() => deleteConnection(transport.id, id));

  const renderField = (field: TransportConfigField, idPrefix: string) => (
    <Field
      key={field.key}
      id={`${idPrefix}-${field.key}`}
      label={field.label}
      hint={field.help}
    >
      {({ id, describedBy }) => (
        <Input
          id={id}
          aria-describedby={describedBy}
          type={field.kind === "secret" ? "password" : "text"}
          autoComplete="off"
          value={values[field.key] ?? ""}
          onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
        />
      )}
    </Field>
  );

  if (!transport.registered) {
    return (
      <p className="text-sm text-muted">
        {transport.name} has not announced itself yet — is its service running?
      </p>
    );
  }
  if (state.kind === "loading") {
    return <p className="text-sm text-faint">Loading connection…</p>;
  }
  if (state.kind === "error") {
    return <p className="text-sm text-danger">{state.message}</p>;
  }

  const connection = state.connection;

  if (!connection) {
    return (
      <div className="space-y-3">
        {transport.connectionConfigSchema.map((field) =>
          renderField(field, `connect-${transport.id}`),
        )}
        {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
        <Button onClick={connect} disabled={busy || requiredMissing}>
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </div>
    );
  }

  const view = connectionStatusView(connection);
  const hasReplacement = Object.values(values).some((value) => value.trim() !== "");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={view.tone} dot>
          {view.label}
        </Badge>
        {view.detail ? <span className="text-sm text-muted">{view.detail}</span> : null}
        {Object.entries(connection.configPreview).map(([key, preview]) => (
          <span key={key} className="font-mono text-xs text-faint">
            {key} {preview}
          </span>
        ))}
      </div>

      {transport.connectionConfigSchema.map((field) =>
        renderField(field, `replace-${transport.id}`),
      )}

      {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => void patch(connection.id, { enabled: !connection.enabled })}
          disabled={busy}
        >
          {connection.enabled ? "Stop" : "Start"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => void patch(connection.id, { config: filledConfig() })}
          disabled={busy || !hasReplacement}
        >
          Save changes
        </Button>
        {confirmingDisconnect ? (
          <>
            <Button variant="danger" onClick={() => void disconnect(connection.id)} disabled={busy}>
              Really disconnect
            </Button>
            <Button variant="ghost" onClick={() => setConfirmingDisconnect(false)} disabled={busy}>
              Keep it
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmingDisconnect(true)} disabled={busy}>
            Disconnect…
          </Button>
        )}
      </div>
      {confirmingDisconnect ? (
        <p className="text-xs text-muted">
          The connection and its stored config are removed and the transport stops running it.
          The assistant itself is untouched.
        </p>
      ) : null}
    </div>
  );
}
