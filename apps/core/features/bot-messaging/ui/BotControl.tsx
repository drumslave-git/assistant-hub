"use client";

import { Play, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";
import type { BotStatus } from "@/server/telegram/bot-manager";

/**
 * Start/Stop control for the in-process Telegram poller. Client Component: posts
 * to the bot control API and refreshes the server-rendered status. The bot reads
 * its token from settings, so starting needs no input here.
 */
export function BotControl({
  initial,
  configured,
}: {
  initial: BotStatus;
  /** Whether a bot token is saved. Start is disabled without one. */
  configured: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = status.state === "running";
  const canStart = running || configured;

  async function control(action: "start" | "stop") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/telegram/bot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json()) as { data?: BotStatus } & ApiErrorBody;
      if (!res.ok) {
        setError(body.error?.message ?? `Request failed (${res.status})`);
        return;
      }
      if (body.data) setStatus(body.data);
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant={running ? "outline" : "primary"}
        onClick={() => control(running ? "stop" : "start")}
        disabled={busy || !canStart}
        leftIcon={running ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      >
        {busy ? "Working…" : running ? "Stop bot" : "Start bot"}
      </Button>
      {!canStart ? (
        <span className="text-sm text-muted">Add a bot token in Settings to start.</span>
      ) : null}
      {status.state === "error" && status.error ? (
        <span className="text-sm text-danger">{status.error}</span>
      ) : null}
      {error ? <span className="text-sm text-danger">{error}</span> : null}
    </div>
  );
}
