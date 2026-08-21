"use client";

import { Check, Users } from "lucide-react";
import { useState } from "react";

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";
import { DEFAULT_CHAT_LANGUAGE } from "@/lib/language";
import type { KnownUser } from "../server/schema";

/**
 * Known-users table with inline alias + language editing. Client Component: each
 * field is edited per row and saved via `PATCH /api/users/[id]` (aliases as a
 * comma-separated list, language as free text). The server normalizes and the
 * returned record replaces the row so the input reflects the stored result. A
 * user's language governs the bot's reply language in their private (DM) chat.
 */

const aliasesToText = (aliases: string[]) => aliases.join(", ");
const textToAliases = (text: string) =>
  text
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

function fullName(user: KnownUser): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || "—";
}

function AliasRow({ user }: { user: KnownUser }) {
  const [stored, setStored] = useState(user.aliases);
  const [text, setText] = useState(aliasesToText(user.aliases));
  const [state, setState] = useState<"idle" | "saving" | "saved" | { error: string }>("idle");

  const dirty = aliasesToText(stored) !== text.trim().replace(/\s*,\s*/g, ", ");

  async function save() {
    setState("saving");
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.userId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ aliases: textToAliases(text) }),
      });
      if (!res.ok) {
        setState({ error: await readError(res) });
        return;
      }
      const { data } = (await res.json()) as { data: KnownUser };
      setStored(data.aliases);
      setText(aliasesToText(data.aliases));
      setState("saved");
    } catch {
      setState({ error: "Network error" });
    }
  }

  return (
    <TableRow>
      <TableCell className="font-medium text-foreground">{fullName(user)}</TableCell>
      <TableCell className="text-muted">{user.username ? `@${user.username}` : "—"}</TableCell>
      <TableCell className="font-mono text-xs text-faint">{user.userId}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setState("idle");
            }}
            placeholder="nickname, other name…"
            className="min-w-[12rem]"
            aria-label={`Aliases for ${fullName(user)}`}
          />
          <Button size="sm" variant="outline" onClick={save} disabled={!dirty || state === "saving"}>
            {state === "saving" ? "Saving…" : "Save"}
          </Button>
          {state === "saved" ? (
            <Check className="h-4 w-4 shrink-0 text-success" aria-label="Saved" />
          ) : null}
        </div>
        {typeof state === "object" ? (
          <p className="mt-1 text-xs text-danger">{state.error}</p>
        ) : null}
      </TableCell>
      <LanguageCell user={user} />
    </TableRow>
  );
}

/**
 * Inline editor for a user's DM reply language: free text saved via
 * `PATCH /api/users/[id]` with a `{ language }` body. Empty clears to the default.
 */
function LanguageCell({ user }: { user: KnownUser }) {
  const [stored, setStored] = useState(user.language ?? "");
  const [text, setText] = useState(user.language ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | { error: string }>("idle");

  const dirty = stored.trim() !== text.trim();

  async function save() {
    setState("saving");
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.userId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: text }),
      });
      if (!res.ok) {
        setState({ error: await readError(res) });
        return;
      }
      const { data } = (await res.json()) as { data: KnownUser };
      const next = data.language ?? "";
      setStored(next);
      setText(next);
      setState("saved");
    } catch {
      setState({ error: "Network error" });
    }
  }

  return (
    <TableCell>
      <div className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setState("idle");
          }}
          placeholder={DEFAULT_CHAT_LANGUAGE}
          className="min-w-[8rem]"
          aria-label={`DM reply language for ${fullName(user)}`}
        />
        <Button size="sm" variant="outline" onClick={save} disabled={!dirty || state === "saving"}>
          {state === "saving" ? "Saving…" : "Save"}
        </Button>
        {state === "saved" ? (
          <Check className="h-4 w-4 shrink-0 text-success" aria-label="Saved" />
        ) : null}
      </div>
      {typeof state === "object" ? <p className="mt-1 text-xs text-danger">{state.error}</p> : null}
    </TableCell>
  );
}

export function KnownUsersTable({ users }: { users: KnownUser[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            Captured automatically on each message. Aliases are alternate names you add; DM language
            is the language the bot must reply in for that user&apos;s private chat (empty = default).
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {users.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No users yet"
            description="Users appear here once they message the bot. Start the bot and send it a message."
          />
        ) : (
          <Table minWidth={900}>
            <TableHead>
              <TableRow header>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Username</TableHeaderCell>
                <TableHeaderCell>User ID</TableHeaderCell>
                <TableHeaderCell>Aliases</TableHeaderCell>
                <TableHeaderCell>DM language</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {users.map((user) => (
                <AliasRow key={user.userId} user={user} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
