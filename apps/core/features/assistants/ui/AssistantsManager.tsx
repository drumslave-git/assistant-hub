"use client";

import { Bot, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import {
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
import { TransportSections } from "@/components/transports/TransportSections";
import { useLiveEvent } from "@/components/realtime/useLiveEvent";
import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";
import type { ApiErrorBody } from "@/lib/api-error";
import { MAX_ASSISTANTS } from "../server/schema";
import type { Assistant } from "../server/schema";

/**
 * Assistants manager. Client Component: create, edit, and delete assistants
 * (name + persona). No "active" selection — the assistant in a chat is
 * implied by which bot is in it; each assistant's transport connection is
 * managed in its editor by the owning source app's extension section (the
 * registry's `assistantSections`, mounted below for existing assistants).
 * Mutations call the assistants API and rely on the shared live-refresh
 * layer; the persona form lives in a modal (the same one-form-for-both
 * decision as personalities, 2026-08-14).
 */

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** Which assistant the dialog is editing, or that it is closed. */
type DialogState = { kind: "closed" } | { kind: "create" } | { kind: "edit"; assistant: Assistant };

/**
 * The one assistant form. Mounted only while open and keyed by its target, so
 * the fields are seeded once per opening and never carry another's text.
 */
function AssistantDialog({
  assistant,
  onClose,
}: {
  /** The assistant being edited, or null to create one. */
  assistant: Assistant | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(assistant?.name ?? "");
  const [persona, setPersona] = useState(assistant?.persona ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Source-app sections re-read their data when the sources' state changes
  // (the tg app publishes `status` on every poller flip).
  const [refreshSignal, setRefreshSignal] = useState(0);
  useLiveEvent(
    "status",
    useCallback(() => setRefreshSignal((n) => n + 1), []),
  );

  const editing = assistant !== null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        editing ? `/api/assistants/${encodeURIComponent(assistant.id)}` : "/api/assistants",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim(), persona }),
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
      title={editing ? `Edit ${assistant.name}` : "New assistant"}
      description="Persona instructions appended to the base system prompt on every reply this assistant sends."
      footer={
        <>
          {error ? <p className="mr-auto text-sm text-danger">{error}</p> : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || name.trim() === ""}>
            {busy ? "Saving…" : editing ? "Save changes" : "Create assistant"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="assistant-name" label="Name">
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
        <Field id="assistant-persona" label="Persona">
          {({ id }) => (
            <Textarea
              id={id}
              rows={8}
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              placeholder="e.g. You are a witty, concise assistant who speaks like a seasoned sysadmin."
            />
          )}
        </Field>

        {/* Transport connection sections, schema-driven from the transport
            registry (Phase 7): each registered transport's piece of this
            assistant. They act on the stored assistant, so they mount only
            when editing one. */}
        {editing ? (
          <TransportSections assistantId={assistant.id} refreshSignal={refreshSignal} />
        ) : null}
      </div>
    </Modal>
  );
}

function AssistantCard({
  assistant,
  onEdit,
  onDelete,
}: {
  assistant: Assistant;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle className="truncate">{assistant.name}</CardTitle>
        </div>
        <CardAction>
          <Button
            size="icon"
            variant="ghost"
            onClick={onEdit}
            aria-label={`Edit ${assistant.name}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            aria-label={`Delete ${assistant.name}`}
          >
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {assistant.persona.trim() ? (
          <p className="text-sm whitespace-pre-wrap text-muted">{assistant.persona}</p>
        ) : (
          <p className="text-sm text-faint">No persona — base system prompt only.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function AssistantsManager({ assistants }: { assistants: Assistant[] }) {
  useLiveRefresh("assistants");
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [state, setState] = useState<DialogState>({ kind: "closed" });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const atLimit = assistants.length >= MAX_ASSISTANTS;

  async function remove(assistant: Assistant) {
    const ok = await confirm({
      title: `Delete "${assistant.name}"?`,
      body:
        "The assistant, its tasks, and its bot connections are removed for good — " +
        "any bot it ran stops polling.",
      confirmLabel: "Delete assistant",
      tone: "danger",
    });
    if (!ok) return;
    setDeleteError(null);
    try {
      const res = await fetch(`/api/assistants/${encodeURIComponent(assistant.id)}`, {
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

      {assistants.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No assistants yet"
          description="Create an assistant, give it a persona, then connect a bot to it."
        />
      ) : (
        <ScrollArea className="space-y-4">
          {assistants.map((a) => (
            <AssistantCard
              key={a.id}
              assistant={a}
              onEdit={() => setState({ kind: "edit", assistant: a })}
              onDelete={() => void remove(a)}
            />
          ))}
        </ScrollArea>
      )}

      <Fab
        label="New assistant"
        icon={<Plus className="h-4 w-4" />}
        onClick={() => setState({ kind: "create" })}
        disabled={atLimit}
        status={atLimit ? { tone: "muted", text: `Limit of ${MAX_ASSISTANTS} reached` } : null}
      />

      {state.kind !== "closed" ? (
        <AssistantDialog
          key={state.kind === "edit" ? state.assistant.id : "new"}
          assistant={state.kind === "edit" ? state.assistant : null}
          onClose={() => setState({ kind: "closed" })}
        />
      ) : null}

      {confirmDialog}
    </div>
  );
}
