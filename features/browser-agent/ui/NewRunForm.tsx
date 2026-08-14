"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Globe } from "lucide-react";

import { Button, Fab, Modal, Textarea } from "@/components/ui";

/**
 * Operator-facing "start a run" form. A dashboard run has no chat to deliver to —
 * the report lands on the run row and is read here — so this is for the operator
 * to exercise or drive the agent directly, mirroring the conversational
 * `browse_web` tool without needing Telegram.
 *
 * The goal is written in a modal (user decision, 2026-08-14) rather than in a
 * card above the run list. It is a one-field form used occasionally, and the
 * list beneath it is what the page is for.
 */
export function NewRunForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setError(null);
  }

  async function start() {
    const trimmed = goal.trim();
    if (trimmed.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/browser", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
      }
      setGoal("");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the run");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Fab
        label="New run"
        icon={<Globe className="h-4 w-4" />}
        onClick={() => setOpen(true)}
      />

      <Modal
        open={open}
        onClose={close}
        busy={busy}
        title="New browser run"
        description="Runs in the background. The report appears in the list when it finishes."
        footer={
          <>
            {error ? <p className="mr-auto text-sm text-danger">{error}</p> : null}
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void start()} disabled={busy || goal.trim().length < 4}>
              {busy ? "Starting…" : "Start run"}
            </Button>
          </>
        }
      >
        <Textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Describe what to find or do on the web — include any links. e.g. “Open example.com, find the pricing page, and tell me the cheapest plan.”"
          rows={5}
          disabled={busy}
          autoFocus
        />
      </Modal>
    </>
  );
}
