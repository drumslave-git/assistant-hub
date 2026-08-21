"use client";

import { Check } from "lucide-react";
import { useState } from "react";

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Textarea,
} from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";
import type { KnownGroup } from "../server/schema";

/**
 * Inline editor for a group's operator notes. Client Component: notes are saved
 * via `PATCH /api/groups/[id]`; the server trims (empty clears to null) and the
 * returned record replaces local state so the field reflects the stored result.
 * Mirrors the known-users alias editor.
 */

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function GroupNotesEditor({ group }: { group: KnownGroup }) {
  const [stored, setStored] = useState(group.notes ?? "");
  const [text, setText] = useState(group.notes ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | { error: string }>("idle");

  const dirty = stored.trim() !== text.trim();

  async function save() {
    setState("saving");
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.chatId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes: text }),
      });
      if (!res.ok) {
        setState({ error: await readError(res) });
        return;
      }
      const { data } = (await res.json()) as { data: KnownGroup };
      const next = data.notes ?? "";
      setStored(next);
      setText(next);
      setState("saved");
    } catch {
      setState({ error: "Network error" });
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Notes</CardTitle>
          <CardDescription>
            A free-text description of this group. Injected into the model&apos;s context for group
            replies alongside the participant roster.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setState("idle");
          }}
          placeholder="e.g. Family group chat. Keep replies casual."
          aria-label="Group notes"
        />
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={save} disabled={!dirty || state === "saving"}>
            {state === "saving" ? "Saving…" : "Save"}
          </Button>
          {state === "saved" ? (
            <Check className="h-4 w-4 shrink-0 text-success" aria-label="Saved" />
          ) : null}
          {typeof state === "object" ? (
            <p className="text-xs text-danger">{state.error}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
