"use client";

import { Pencil, Plus, Star, Trash2, VenetianMask } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Fab,
  Field,
  Input,
  Modal,
  ScrollArea,
  Textarea,
  useConfirm,
} from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";
import { MAX_PERSONALITIES } from "../server/schema";
import type { Personality } from "../server/schema";

/**
 * Personalities manager. Client Component: create, edit, delete named personas
 * and pick the active one. Each mutation calls the personalities API, then
 * `router.refresh()` re-reads the server-rendered list + active selection.
 *
 * Writing a persona happens in a modal (user decision, 2026-08-14) — one form
 * for both create and edit, so the two cannot drift, and the page underneath
 * stays a list. Editing used to expand a card in place, which pushed every row
 * below it down the page while you typed.
 */

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** Which persona the dialog is editing, or that it is closed. */
type DialogState = { kind: "closed" } | { kind: "create" } | { kind: "edit"; personality: Personality };

/**
 * The one persona form. Mounted only while open and keyed by its target, so the
 * fields are seeded once per opening and never carry a previous persona's text.
 */
function PersonalityDialog({
  personality,
  onClose,
}: {
  /** The persona being edited, or null to create one. */
  personality: Personality | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(personality?.name ?? "");
  const [prompt, setPrompt] = useState(personality?.prompt ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editing = personality !== null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        editing ? `/api/personalities/${encodeURIComponent(personality.id)}` : "/api/personalities",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim(), prompt }),
        },
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      onClose();
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      title={editing ? `Edit ${personality.name}` : "New personality"}
      description="Persona instructions appended to the bot's base system prompt while this personality is active."
      footer={
        <>
          {error ? <p className="mr-auto text-sm text-danger">{error}</p> : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || name.trim() === ""}>
            {busy ? "Saving…" : editing ? "Save changes" : "Create personality"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="personality-name" label="Name">
          {({ id }) => (
            <Input
              id={id}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Grumpy sysadmin"
              autoFocus
            />
          )}
        </Field>
        <Field id="personality-prompt" label="Prompt">
          {({ id }) => (
            <Textarea
              id={id}
              rows={8}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. You are a witty, concise assistant who speaks like a seasoned sysadmin."
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

function PersonalityCard({
  personality,
  active,
  onEdit,
  onDelete,
}: {
  personality: Personality;
  active: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setActive(personalityId: string | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/personalities/active", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personalityId }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
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
            <Button size="sm" variant="ghost" onClick={() => setActive(null)} disabled={busy}>
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
            onClick={onEdit}
            disabled={busy}
            aria-label={`Edit ${personality.name}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            disabled={busy}
            aria-label={`Delete ${personality.name}`}
          >
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {personality.prompt.trim() ? (
          <p className="text-sm whitespace-pre-wrap text-muted">{personality.prompt}</p>
        ) : (
          <p className="text-sm text-faint">No prompt — base system prompt only.</p>
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
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [state, setState] = useState<DialogState>({ kind: "closed" });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const atLimit = personalities.length >= MAX_PERSONALITIES;

  async function remove(personality: Personality) {
    const ok = await confirm({
      title: `Delete "${personality.name}"?`,
      body: "The personality is removed for good. If it is the active one, the bot falls back to its base prompt.",
      confirmLabel: "Delete personality",
      tone: "danger",
    });
    if (!ok) return;
    setDeleteError(null);
    try {
      const res = await fetch(`/api/personalities/${encodeURIComponent(personality.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setDeleteError(await readError(res));
        return;
      }
      router.refresh();
    } catch {
      setDeleteError("Network error — could not reach the server");
    }
  }

  return (
    <div className="space-y-6">
      {deleteError ? <p className="text-sm text-danger">{deleteError}</p> : null}

      {personalities.length === 0 ? (
        <EmptyState
          icon={VenetianMask}
          title="No personalities yet"
          description="Create a personality, then set it active to shape every bot reply."
        />
      ) : (
        <ScrollArea className="space-y-4">
          {personalities.map((p) => (
            <PersonalityCard
              key={p.id}
              personality={p}
              active={p.id === activeId}
              onEdit={() => setState({ kind: "edit", personality: p })}
              onDelete={() => void remove(p)}
            />
          ))}
        </ScrollArea>
      )}

      <Fab
        label="New personality"
        icon={<Plus className="h-4 w-4" />}
        onClick={() => setState({ kind: "create" })}
        disabled={atLimit}
        status={atLimit ? { tone: "muted", text: `Limit of ${MAX_PERSONALITIES} reached` } : null}
      />

      {state.kind !== "closed" ? (
        <PersonalityDialog
          key={state.kind === "edit" ? state.personality.id : "new"}
          personality={state.kind === "edit" ? state.personality : null}
          onClose={() => setState({ kind: "closed" })}
        />
      ) : null}

      {confirmDialog}
    </div>
  );
}
