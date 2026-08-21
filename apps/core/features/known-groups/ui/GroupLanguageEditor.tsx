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
  Input,
} from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";
import { DEFAULT_CHAT_LANGUAGE } from "@/lib/language";
import type { KnownGroup } from "../server/schema";

/**
 * Inline editor for a group's reply language. Client Component: the language is
 * saved via `PATCH /api/groups/[id]` with a `{ language }` body; the server
 * normalizes (empty clears to null → default) and the returned record replaces
 * local state. Mirrors the notes editor.
 */

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function GroupLanguageEditor({ group }: { group: KnownGroup }) {
  const [stored, setStored] = useState(group.language ?? "");
  const [text, setText] = useState(group.language ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | { error: string }>("idle");

  const dirty = stored.trim() !== text.trim();

  async function save() {
    setState("saving");
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.chatId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: text }),
      });
      if (!res.ok) {
        setState({ error: await readError(res) });
        return;
      }
      const { data } = (await res.json()) as { data: KnownGroup };
      const next = data.language ?? "";
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
          <CardTitle>Language</CardTitle>
          <CardDescription>
            The language the bot must reply in for this group. Leave empty to use the default (
            {DEFAULT_CHAT_LANGUAGE}). The bot is strictly instructed to write every reply here in this
            language, whatever language members write in.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <Input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setState("idle");
            }}
            placeholder={DEFAULT_CHAT_LANGUAGE}
            className="max-w-xs"
            aria-label="Group reply language"
          />
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
