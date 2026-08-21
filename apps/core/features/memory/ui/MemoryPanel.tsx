"use client";

import { Brain, Inbox, Library, Pencil, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  EmptyState,
  ScrollArea,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  Textarea,
  type TabItem,
} from "@/components/ui";
import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";
import { Timestamp } from "@/components/time/Timestamp";
import type { MemoryView } from "@/features/memory/server/service";
import type { ApiErrorBody } from "@/lib/api-error";

/**
 * The memory dashboard body: the pending queue, each person's memory document,
 * and the general-knowledge facts — all editable, because a bot that remembers
 * the wrong thing needs a correction path that does not involve a database
 * client.
 *
 * Client Component for the live SSE refresh and the edit forms; all data arrives
 * server-rendered via props.
 */

/** One mutation against the memory API, with shared error + refresh handling. */
function useMemoryMutation() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mutate(
    url: string,
    init: RequestInit,
    onDone?: () => void,
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        ...init,
        headers: init.body ? { "Content-Type": "application/json" } : undefined,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
        setError(body.error?.message ?? `Request failed (${res.status})`);
        return false;
      }
      onDone?.();
      router.refresh();
      return true;
    } catch {
      setError("Network error — could not reach the server");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { mutate, busy, error };
}

/** Badge for a row whose text is stored but not embedded (found by keyword only). */
function EmbeddedBadge({ embedded }: { embedded: boolean }) {
  if (embedded) return null;
  return <Badge tone="neutral">Not searchable by meaning</Badge>;
}

/** An editable block of memory text: read-only until "Edit", then save or cancel. */
function EditableMemory({
  content,
  saveUrl,
  deleteUrl,
  deleteLabel,
}: {
  content: string;
  saveUrl: string;
  deleteUrl: string;
  deleteLabel: string;
}) {
  const { mutate, busy, error } = useMemoryMutation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);

  if (!editing) {
    return (
      <div className="space-y-2">
        <p className="whitespace-pre-wrap text-sm text-foreground">{content}</p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft(content);
              setEditing(true);
            }}
            leftIcon={<Pencil className="h-4 w-4" />}
          >
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void mutate(deleteUrl, { method: "DELETE" })}
            leftIcon={<Trash2 className="h-4 w-4" />}
          >
            {deleteLabel}
          </Button>
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(16, Math.max(3, draft.split("\n").length + 1))}
        aria-label="Memory content"
      />
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || draft.trim().length === 0 || draft === content}
          onClick={() =>
            void mutate(
              saveUrl,
              { method: "PATCH", body: JSON.stringify({ content: draft }) },
              () => setEditing(false),
            )
          }
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setEditing(false)}
          leftIcon={<X className="h-4 w-4" />}
        >
          Cancel
        </Button>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}

/** One row of the pending queue, with a discard button. */
function PendingRow({
  id,
  scope,
  userLabel,
  content,
  createdAt,
}: {
  id: string;
  scope: string;
  userLabel: string | null;
  content: string;
  createdAt: string;
}) {
  const { mutate, busy } = useMemoryMutation();
  return (
    <TableRow>
      <TableCell>
        <Badge tone={scope === "user" ? "primary" : "info"}>
          {scope === "user" ? (userLabel ?? "User") : "General"}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-pre-wrap">{content}</TableCell>
      <TableCell>
        <Timestamp iso={createdAt} />
      </TableCell>
      <TableCell>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() =>
            void mutate(`/api/memory/entries/${id}`, { method: "DELETE" })
          }
          leftIcon={<Trash2 className="h-4 w-4" />}
        >
          Discard
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function MemoryPanel({ view }: { view: MemoryView }) {
  useLiveRefresh("memory");
  const { entries, users, general, generalPendingNotes } = view;

  const pendingTab = (
    <Card>
      <CardHeader>
        <CardDescription>
          Facts the bot saved during conversation, waiting for the nightly
          job to fold them into durable memory. They are not part of memory
          yet — the bot cannot recall them until they are consolidated.
          Discard one here if it should never have been remembered.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="Nothing pending"
            description="Every saved fact has been consolidated."
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Scope</TableHeaderCell>
                <TableHeaderCell>Fact</TableHeaderCell>
                <TableHeaderCell>Saved</TableHeaderCell>
                <TableHeaderCell>
                  <span className="sr-only">Actions</span>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map((entry) => (
                <PendingRow
                  key={entry.id}
                  id={entry.id}
                  scope={entry.scope}
                  userLabel={entry.userLabel}
                  content={entry.content}
                  createdAt={entry.createdAt}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );

  const peopleTab = (
    <Card>
      <CardHeader>
        <CardDescription>
          What the bot durably knows about each person — one merged document
          each, injected into the replies of the chats they take part in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {users.length === 0 ? (
          <EmptyState
            icon={Brain}
            title="No one remembered yet"
            description="The bot stores a fact about someone when it is told to remember one, or when a person reveals something lastingly true."
          />
        ) : (
          <ScrollArea>
            <ul className="space-y-6">
              {users.map((user) => (
                <li
                  key={user.userId}
                  className="space-y-2 border-b border-border pb-6 last:border-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">
                      {user.userLabel}
                    </span>
                    <EmbeddedBadge embedded={user.embedded} />
                    {user.pendingNotes > 0 ? (
                      <Badge tone="warning">
                        {user.pendingNotes} note
                        {user.pendingNotes === 1 ? "" : "s"} pending
                      </Badge>
                    ) : null}
                    <span className="text-sm text-muted">
                      updated <Timestamp iso={user.updatedAt} />
                    </span>
                  </div>
                  <EditableMemory
                    content={user.content}
                    saveUrl={`/api/memory/users/${user.userId}`}
                    deleteUrl={`/api/memory/users/${user.userId}`}
                    deleteLabel="Forget this person"
                  />
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );

  const generalTab = (
    <Card>
      <CardHeader>
        <CardDescription>
          One document of shared facts — definitions, rules, conventions,
          and facts about people the bot cannot file under a person of their
          own. Injected into every reply.
        </CardDescription>
        <CardAction>
          {generalPendingNotes > 0 ? (
            <Badge tone="warning">
              {generalPendingNotes} note{generalPendingNotes === 1 ? "" : "s"}{" "}
              pending
            </Badge>
          ) : null}
        </CardAction>
      </CardHeader>
      <CardContent>
        {general == null ? (
          <EmptyState
            icon={Library}
            title="No general knowledge yet"
            description="The bot adds to this document when it learns something shared — a definition, a rule, a convention — or a fact about someone it cannot remember as a person."
          />
        ) : (
          <div className="space-y-2">
            <span className="text-sm text-muted">
              updated <Timestamp iso={general.updatedAt} />
            </span>
            <EditableMemory
              content={general.content}
              saveUrl="/api/memory/general"
              deleteUrl="/api/memory/general"
              deleteLabel="Forget all general knowledge"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );

  const tabs: TabItem[] = [
    { id: "pending", label: `Pending notes (${entries.length})`, content: pendingTab },
    { id: "people", label: `People (${users.length})`, content: peopleTab },
    { id: "general", label: "General knowledge", content: generalTab },
  ];

  return <Tabs tabs={tabs} />;
}
