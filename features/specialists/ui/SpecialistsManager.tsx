"use client";

import {
  Check,
  GraduationCap,
  Inbox,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { JsonBlock } from "@/components/debug";
import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";
import { Timestamp } from "@/components/time/Timestamp";
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  ScrollArea,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  Textarea,
} from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";
import {
  DATA_SCOPES,
  MAX_SPECIALISTS,
  type ChatSpecialist,
  type DataScope,
  type Specialist,
  type SpecialistEntry,
} from "../server/schema";

/**
 * Specialists manager. Client Component with three tabbed sections (the shared
 * Tabs pattern): the CRUD list, the per-chat assignment view, and the entries
 * browser. Each mutation calls the specialists API, then `router.refresh()`
 * re-reads the server-rendered props; the whole page live-updates over the
 * shared SSE stream (`specialists` topic).
 */

/** A chat the assignment view can assign to (groups + DM chats). */
export interface AssignableChat {
  chatId: string;
  label: string;
  kind: "group" | "dm";
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

const SCOPE_LABELS: Record<DataScope, string> = {
  "per-chat": "Per chat (each chat is its own silo)",
  shared: "Shared (one pool across every chat)",
};

function ScopeFields({
  description,
  setDescription,
  instructions,
  setInstructions,
  dataScope,
  setDataScope,
  idPrefix,
  disabled,
}: {
  description: string;
  setDescription: (v: string) => void;
  instructions: string;
  setInstructions: (v: string) => void;
  dataScope: DataScope;
  setDataScope: (v: DataScope) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  return (
    <>
      <Field
        id={`${idPrefix}-description`}
        label="Description"
        hint="What this specialist is for — shown to users when they ask what specialists exist."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. A private daily journal with gentle analysis."
            disabled={disabled}
          />
        )}
      </Field>
      <Field
        id={`${idPrefix}-instructions`}
        label="Instructions"
        hint="Role instructions stacked onto the base prompt and active personality while this specialist is active in a chat."
      >
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            rows={6}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g. You act as a supportive daily journal keeper for this chat…"
            disabled={disabled}
          />
        )}
      </Field>
      <Field
        id={`${idPrefix}-scope`}
        label="Data scope"
        hint="How stored entries are read: siloed per chat, or one shared pool across every chat where this specialist is active."
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={dataScope}
            onChange={(e) => setDataScope(e.target.value as DataScope)}
            disabled={disabled}
          >
            {DATA_SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {SCOPE_LABELS[scope]}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </>
  );
}

function CreateForm({ atLimit }: { atLimit: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [dataScope, setDataScope] = useState<DataScope>("per-chat");
  const [state, setState] = useState<"idle" | "saving" | { error: string }>("idle");

  async function create() {
    setState("saving");
    try {
      const res = await fetch("/api/specialists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description, instructions, dataScope }),
      });
      if (!res.ok) {
        setState({ error: await readError(res) });
        return;
      }
      setName("");
      setDescription("");
      setInstructions("");
      setDataScope("per-chat");
      setState("idle");
      router.refresh();
    } catch {
      setState({ error: "Network error — could not reach the server" });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New specialist</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field id="new-specialist-name" label="Name">
          {({ id }) => (
            <Input
              id={id}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setState("idle");
              }}
              placeholder="e.g. Daily psycho journal"
              disabled={atLimit}
            />
          )}
        </Field>
        <ScopeFields
          idPrefix="new-specialist"
          description={description}
          setDescription={setDescription}
          instructions={instructions}
          setInstructions={setInstructions}
          dataScope={dataScope}
          setDataScope={setDataScope}
          disabled={atLimit}
        />
        <div className="flex items-center gap-3">
          <Button
            onClick={create}
            disabled={atLimit || name.trim() === "" || state === "saving"}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            {state === "saving" ? "Creating…" : "Create specialist"}
          </Button>
          {atLimit ? (
            <span className="text-sm text-muted">Limit of {MAX_SPECIALISTS} reached.</span>
          ) : null}
          {typeof state === "object" ? (
            <span className="text-sm text-danger">{state.error}</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function SpecialistCard({
  specialist,
  activeChatCount,
}: {
  specialist: Specialist;
  activeChatCount: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(specialist.name);
  const [description, setDescription] = useState(specialist.description);
  const [instructions, setInstructions] = useState(specialist.instructions);
  const [dataScope, setDataScope] = useState<DataScope>(specialist.dataScope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetEdit() {
    setName(specialist.name);
    setDescription(specialist.description);
    setInstructions(specialist.instructions);
    setDataScope(specialist.dataScope);
    setError(null);
    setEditing(false);
  }

  async function mutate(run: () => Promise<Response>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      const res = await run();
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      after?.();
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    mutate(
      () =>
        fetch(`/api/specialists/${encodeURIComponent(specialist.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim(), description, instructions, dataScope }),
        }),
      () => setEditing(false),
    );

  const remove = () => {
    if (
      !confirm(
        `Delete specialist "${specialist.name}"? Its chat activations and stored entries are deleted with it. This cannot be undone.`,
      )
    )
      return;
    return mutate(() =>
      fetch(`/api/specialists/${encodeURIComponent(specialist.id)}`, { method: "DELETE" }),
    );
  };

  if (editing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Edit specialist</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field id={`edit-name-${specialist.id}`} label="Name">
            {({ id }) => (
              <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          <ScopeFields
            idPrefix={`edit-${specialist.id}`}
            description={description}
            setDescription={setDescription}
            instructions={instructions}
            setInstructions={setInstructions}
            dataScope={dataScope}
            setDataScope={setDataScope}
          />
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </CardContent>
        <CardFooter>
          <Button
            size="sm"
            onClick={save}
            disabled={busy || name.trim() === ""}
            leftIcon={<Check className="h-4 w-4" />}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={resetEdit}
            disabled={busy}
            leftIcon={<X className="h-4 w-4" />}
          >
            Cancel
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle className="truncate">{specialist.name}</CardTitle>
          <Badge tone={specialist.dataScope === "shared" ? "info" : "neutral"}>
            {specialist.dataScope === "shared" ? "Shared data" : "Per-chat data"}
          </Badge>
          {activeChatCount > 0 ? (
            <Badge tone="success" dot>
              Active in {activeChatCount} {activeChatCount === 1 ? "chat" : "chats"}
            </Badge>
          ) : null}
        </div>
        <CardAction>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setEditing(true)}
            disabled={busy}
            aria-label={`Edit ${specialist.name}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={remove}
            disabled={busy}
            aria-label={`Delete ${specialist.name}`}
          >
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {specialist.description.trim() ? (
          <p className="text-sm text-foreground">{specialist.description}</p>
        ) : null}
        {specialist.instructions.trim() ? (
          <p className="whitespace-pre-wrap text-sm text-muted">{specialist.instructions}</p>
        ) : (
          <p className="text-sm text-faint">No instructions — name and description only.</p>
        )}
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

function AssignmentsTable({
  chats,
  specialists,
  assignments,
}: {
  chats: AssignableChat[];
  specialists: Specialist[];
  assignments: ChatSpecialist[];
}) {
  const router = useRouter();
  const [busyChat, setBusyChat] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const byChat = useMemo(
    () => new Map(assignments.map((a) => [a.chatId, a])),
    [assignments],
  );

  async function assign(chatId: string, specialistId: string | null) {
    setBusyChat(chatId);
    setError(null);
    try {
      const res = await fetch("/api/specialists/assignments", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId, specialistId }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusyChat(null);
    }
  }

  if (chats.length === 0) {
    return (
      <EmptyState
        icon={GraduationCap}
        title="No chats yet"
        description="Chats appear here once someone (or some group) has talked to the bot."
      />
    );
  }

  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell>Chat</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>Active specialist</TableHeaderCell>
            <TableHeaderCell>Since</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {chats.map((chat) => {
            const assignment = byChat.get(chat.chatId);
            return (
              <TableRow key={chat.chatId}>
                <TableCell className="font-medium">{chat.label}</TableCell>
                <TableCell>
                  <Badge tone="neutral">{chat.kind === "group" ? "Group" : "DM"}</Badge>
                </TableCell>
                <TableCell>
                  <Select
                    aria-label={`Active specialist for ${chat.label}`}
                    value={assignment?.specialistId ?? ""}
                    onChange={(e) => assign(chat.chatId, e.target.value || null)}
                    disabled={busyChat === chat.chatId}
                    className="max-w-72"
                  >
                    <option value="">(none)</option>
                    {specialists.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </TableCell>
                <TableCell>
                  <Timestamp iso={assignment?.updatedAt ?? null} fallback="—" />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function EntriesBrowser({
  entries,
  specialists,
  chats,
}: {
  entries: SpecialistEntry[];
  specialists: Specialist[];
  chats: AssignableChat[];
}) {
  const [specialistId, setSpecialistId] = useState("");
  const [chatId, setChatId] = useState("");
  const [collection, setCollection] = useState("");

  const specialistNames = useMemo(
    () => new Map(specialists.map((s) => [s.id, s.name])),
    [specialists],
  );
  const chatLabels = useMemo(() => new Map(chats.map((c) => [c.chatId, c.label])), [chats]);
  const collections = useMemo(
    () => [...new Set(entries.map((e) => e.collection))].sort(),
    [entries],
  );

  const filtered = entries.filter(
    (e) =>
      (!specialistId || e.specialistId === specialistId) &&
      (!chatId || e.chatId === chatId) &&
      (!collection || e.collection === collection),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Select
          aria-label="Filter by specialist"
          value={specialistId}
          onChange={(e) => setSpecialistId(e.target.value)}
          className="max-w-60"
        >
          <option value="">All specialists</option>
          {specialists.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by chat"
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          className="max-w-60"
        >
          <option value="">All chats</option>
          {chats.map((c) => (
            <option key={c.chatId} value={c.chatId}>
              {c.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by collection"
          value={collection}
          onChange={(e) => setCollection(e.target.value)}
          className="max-w-60"
        >
          <option value="">All collections</option>
          {collections.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No entries"
          description="Entries appear here as specialists store data from their chats."
        />
      ) : (
        <ScrollArea className="space-y-3">
          {filtered.map((entry) => (
            <Card key={entry.id}>
              <CardHeader>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge tone="info">{entry.collection}</Badge>
                  <span className="truncate text-sm font-medium">
                    {specialistNames.get(entry.specialistId) ?? entry.specialistId}
                  </span>
                  <span className="text-sm text-muted">
                    {chatLabels.get(entry.chatId) ?? `Chat ${entry.chatId}`}
                  </span>
                  {entry.authorUserId ? (
                    <span className="text-sm text-faint">by user {entry.authorUserId}</span>
                  ) : null}
                </div>
                <CardAction>
                  <Timestamp iso={entry.createdAt} className="text-sm text-muted" />
                </CardAction>
              </CardHeader>
              <CardContent>
                <JsonBlock value={entry.payload} defaultExpanded />
              </CardContent>
            </Card>
          ))}
        </ScrollArea>
      )}
    </div>
  );
}

export function SpecialistsManager({
  specialists,
  assignments,
  chats,
  entries,
}: {
  specialists: Specialist[];
  assignments: ChatSpecialist[];
  chats: AssignableChat[];
  entries: SpecialistEntry[];
}) {
  useLiveRefresh("specialists");

  const activeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of assignments) counts.set(a.specialistId, (counts.get(a.specialistId) ?? 0) + 1);
    return counts;
  }, [assignments]);

  return (
    <Tabs
      tabs={[
        {
          id: "specialists",
          label: "Specialists",
          content: (
            <div className="space-y-6">
              <CreateForm atLimit={specialists.length >= MAX_SPECIALISTS} />
              {specialists.length === 0 ? (
                <EmptyState
                  icon={GraduationCap}
                  title="No specialists yet"
                  description="Create a specialist above, then activate it for a chat on the assignments tab."
                />
              ) : (
                <ScrollArea className="space-y-4">
                  {specialists.map((s) => (
                    <SpecialistCard
                      key={s.id}
                      specialist={s}
                      activeChatCount={activeCounts.get(s.id) ?? 0}
                    />
                  ))}
                </ScrollArea>
              )}
            </div>
          ),
        },
        {
          id: "assignments",
          label: "Chat assignments",
          content: (
            <AssignmentsTable chats={chats} specialists={specialists} assignments={assignments} />
          ),
        },
        {
          id: "entries",
          label: "Entries",
          content: <EntriesBrowser entries={entries} specialists={specialists} chats={chats} />,
        },
      ]}
    />
  );
}
