"use client";

import { useCallback, useEffect, useState } from "react";

import type { OperatorConnection } from "@assistant-hub/contracts";
import {
  Badge,
  Button,
  Field,
  Input,
  readApiError,
  type ApiOkBody,
  type AssistantSectionProps,
  type BadgeTone,
} from "@assistant-hub/ui";

/**
 * The assistant editor's Telegram section: the assistant's bot connection,
 * managed over the tg operator API behind the core proxy
 * (`/api/telegram/connections`). One bot per assistant (the store's unique
 * index); the token is write-only — the listing carries only its last four
 * characters. Poller state renders live: the shell bumps `refreshSignal` on
 * every `status` event and the section re-reads.
 */

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; connection: OperatorConnection | null };

/** Presentation of one connection's live poller state. */
function statusView(connection: OperatorConnection): {
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
    // Desired running but no poller tracked — the tg service has not
    // reconciled (or is down); honest state, not a green light.
    return {
      tone: "warning",
      label: "Not tracked",
      detail: "enabled, but no poller is tracked — is the telegram service running?",
    };
  }
  return { tone: "neutral", label: "Stopped", detail: null };
}

export function TgConnectionSection({ assistantId, refreshSignal }: AssistantSectionProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/telegram/connections?assistantId=${encodeURIComponent(assistantId)}`,
      );
      if (!res.ok) {
        setState({ kind: "error", message: await readApiError(res) });
        return;
      }
      const body = (await res.json()) as ApiOkBody<{ connections: OperatorConnection[] }>;
      setState({ kind: "ready", connection: body.data?.connections[0] ?? null });
    } catch {
      setState({ kind: "error", message: "Network error — could not reach the server" });
    }
  }, [assistantId]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  /** Run one mutation, then re-read the connection. */
  async function mutate(request: () => Promise<Response>): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const res = await request();
      if (!res.ok) {
        setActionError(await readApiError(res));
        return;
      }
      setToken("");
      setConfirmingDisconnect(false);
      await load();
    } catch {
      setActionError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  const connect = () =>
    mutate(() =>
      fetch("/api/telegram/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assistantId, botToken: token.trim() }),
      }),
    );

  const patch = (id: string, body: { botToken?: string; enabled?: boolean }) =>
    mutate(() =>
      fetch(`/api/telegram/connections/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const disconnect = (id: string) =>
    mutate(() =>
      fetch(`/api/telegram/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
    );

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
        <Field
          id="tg-bot-token"
          label="Bot token"
          hint="From @BotFather. Stored by the telegram service; never shown again. The bot starts polling as soon as it connects."
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="123456:ABC-DEF…"
            />
          )}
        </Field>
        {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
        <Button onClick={connect} disabled={busy || token.trim() === ""}>
          {busy ? "Connecting…" : "Connect bot"}
        </Button>
      </div>
    );
  }

  const view = statusView(connection);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={view.tone} dot>
          {view.label}
        </Badge>
        {view.detail ? <span className="text-sm text-muted">{view.detail}</span> : null}
        <span className="font-mono text-xs text-faint">token …{connection.botTokenHint}</span>
      </div>

      <Field
        id="tg-bot-token-replace"
        label="Replace token"
        hint="Paste a new token from @BotFather to switch bots; a running poller restarts on it."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="123456:ABC-DEF…"
          />
        )}
      </Field>

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
          onClick={() => void patch(connection.id, { botToken: token.trim() })}
          disabled={busy || token.trim() === ""}
        >
          Replace token
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
          The connection and its stored token are removed and the bot stops polling. The
          assistant itself is untouched.
        </p>
      ) : null}
    </div>
  );
}
