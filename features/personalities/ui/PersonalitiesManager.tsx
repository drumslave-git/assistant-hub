"use client";

import {
  Check,
  Pencil,
  Plus,
  Star,
  Trash2,
  VenetianMask,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

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
  Fab,
  Field,
  Input,
  ScrollArea,
  Textarea,
} from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";
import { MAX_PERSONALITIES } from "../server/schema";
import type { Personality } from "../server/schema";

/**
 * Personalities manager. Client Component: create, edit, delete named personas
 * and pick the active one. Each mutation calls the personalities API, then
 * `router.refresh()` re-reads the server-rendered list + active selection.
 * Built from the shared UI-kit `Card`/`Field` primitives — no bespoke chrome.
 */

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

function CreateForm({ atLimit }: { atLimit: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [state, setState] = useState<"idle" | "saving" | { error: string }>(
    "idle",
  );

  async function create() {
    setState("saving");
    try {
      const res = await fetch("/api/personalities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), prompt }),
      });
      if (!res.ok) {
        setState({ error: await readError(res) });
        return;
      }
      setName("");
      setPrompt("");
      setState("idle");
      router.refresh();
    } catch {
      setState({ error: "Network error — could not reach the server" });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New personality</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field id="new-personality-name" label="Name">
          {({ id }) => (
            <Input
              id={id}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setState("idle");
              }}
              placeholder="e.g. Grumpy sysadmin"
              disabled={atLimit}
            />
          )}
        </Field>
        <Field
          id="new-personality-prompt"
          label="Prompt"
          hint="Persona instructions appended to the bot's base system prompt when active."
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={4}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setState("idle");
              }}
              placeholder="e.g. You are a witty, concise assistant who speaks like a seasoned sysadmin."
              disabled={atLimit}
            />
          )}
        </Field>
        <Fab
          label="Create personality"
          busyLabel="Creating…"
          icon={<Plus className="h-4 w-4" />}
          onClick={create}
          busy={state === "saving"}
          disabled={atLimit || name.trim() === ""}
          // The limit outranks a stale error: it is why the button is dead now,
          // which is the question a disabled control raises.
          status={
            atLimit
              ? { tone: "muted", text: `Limit of ${MAX_PERSONALITIES} reached` }
              : typeof state === "object"
                ? { tone: "danger", text: state.error }
                : null
          }
        />
      </CardContent>
    </Card>
  );
}

function PersonalityCard({
  personality,
  active,
}: {
  personality: Personality;
  active: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(personality.name);
  const [prompt, setPrompt] = useState(personality.prompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetEdit() {
    setName(personality.name);
    setPrompt(personality.prompt);
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
        fetch(`/api/personalities/${encodeURIComponent(personality.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim(), prompt }),
        }),
      () => setEditing(false),
    );

  const remove = () => {
    if (
      !confirm(
        `Delete personality "${personality.name}"? This cannot be undone.`,
      )
    )
      return;
    return mutate(() =>
      fetch(`/api/personalities/${encodeURIComponent(personality.id)}`, {
        method: "DELETE",
      }),
    );
  };

  const setActive = (personalityId: string | null) =>
    mutate(() =>
      fetch("/api/personalities/active", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personalityId }),
      }),
    );

  if (editing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Edit personality</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field id={`edit-name-${personality.id}`} label="Name">
            {({ id }) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field id={`edit-prompt-${personality.id}`} label="Prompt">
            {({ id }) => (
              <Textarea
                id={id}
                rows={5}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            )}
          </Field>
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
          <CardTitle className="truncate">{personality.name}</CardTitle>
          {active ? (
            <Badge tone="success" dot>
              Active
            </Badge>
          ) : null}
        </div>
        <CardAction>
          {active ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setActive(null)}
              disabled={busy}
            >
              Deactivate
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setActive(personality.id)}
              disabled={busy}
              leftIcon={<Star className="h-4 w-4" />}
            >
              Set active
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setEditing(true)}
            disabled={busy}
            aria-label={`Edit ${personality.name}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={remove}
            disabled={busy}
            aria-label={`Delete ${personality.name}`}
          >
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {personality.prompt.trim() ? (
          <p className="whitespace-pre-wrap text-sm text-muted">
            {personality.prompt}
          </p>
        ) : (
          <p className="text-sm text-faint">
            No prompt — base system prompt only.
          </p>
        )}
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

export function PersonalitiesManager({
  personalities,
  activeId,
}: {
  personalities: Personality[];
  activeId: string | null;
}) {
  return (
    <div className="space-y-6">
      <CreateForm atLimit={personalities.length >= MAX_PERSONALITIES} />

      {personalities.length === 0 ? (
        <EmptyState
          icon={VenetianMask}
          title="No personalities yet"
          description="Create a personality above, then set it active to shape every bot reply."
        />
      ) : (
        <ScrollArea className="space-y-4">
          {personalities.map((p) => (
            <PersonalityCard
              key={p.id}
              personality={p}
              active={p.id === activeId}
            />
          ))}
        </ScrollArea>
      )}
    </div>
  );
}
