"use client";

import { Pencil, Plug, Plus, Server, Trash2 } from "lucide-react";
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
  useConfirm,
} from "@/components/ui";
import { readApiError } from "@/lib/api-error";
import { DEFAULT_LLM_BACKEND, llmBackendLabel, type LlmBackendId } from "@/lib/llm-backend";
import type { Backend } from "../server/schema";
import { BackendTypeField } from "./BackendTypeField";

/**
 * Backends manager. Client Component: create, edit, delete the endpoint
 * catalog the settings roles pick from, and test any entry — one call proves
 * the host answers and the key is accepted, and doubles as the model preview.
 * Each mutation calls the backends API, then `router.refresh()` re-reads the
 * server-rendered list.
 *
 * Writing a backend happens in a modal (user decision, 2026-08-14): one form for
 * create and edit, so the two cannot drift apart — they already differ in the
 * only place they must (an edit sends a changed-only patch and keeps the stored
 * key unless the field is touched).
 */

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; models: string[] }
  | { kind: "error"; message: string };

/** The test button + its outcome row (count badge and expandable model list). */
function TestConnection({
  state,
  onTest,
  disabled,
}: {
  state: TestState;
  onTest: () => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onTest}
          disabled={disabled || state.kind === "testing"}
          leftIcon={<Plug className="h-4 w-4" />}
        >
          {state.kind === "testing" ? "Testing…" : "Test connection"}
        </Button>
        {state.kind === "ok" ? (
          <>
            <Badge tone="success" dot>
              Connected — {state.models.length} models
            </Badge>
            {state.models.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? "Hide models" : "Show models"}
              </Button>
            ) : null}
          </>
        ) : null}
        {state.kind === "error" ? (
          <span className="text-sm text-danger">{state.message}</span>
        ) : null}
      </div>
      {state.kind === "ok" && expanded ? (
        <ul className="max-h-48 overflow-y-auto rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
          {state.models.map((model) => (
            <li key={model} className="truncate py-0.5 font-mono text-xs">
              {model}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function useTest() {
  const [state, setState] = useState<TestState>({ kind: "idle" });
  async function run(body: Record<string, unknown>) {
    setState({ kind: "testing" });
    try {
      const res = await fetch("/api/backends/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setState({ kind: "error", message: await readApiError(res) });
        return;
      }
      const { data } = (await res.json()) as { data: { models: string[] } };
      setState({ kind: "ok", models: data.models });
    } catch {
      setState({ kind: "error", message: "Network error — could not reach the server" });
    }
  }
  return { state, run, reset: () => setState({ kind: "idle" }) };
}

/** Which backend the dialog is editing, or that it is closed. */
type DialogState = { kind: "closed" } | { kind: "create" } | { kind: "edit"; backend: Backend };

/**
 * The one backend form. Mounted only while open and keyed by its target, so the
 * fields are seeded once per opening and never carry a previous backend's URL.
 */
function BackendDialog({
  backend,
  onClose,
  onSaved,
}: {
  /** The backend being edited, or null to create one. */
  backend: Backend | null;
  onClose: () => void;
  /** Reports models the save cleared, so the page can say so after the dialog goes. */
  onSaved: (clearedModels: string[]) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(backend?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(backend?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [keyDirty, setKeyDirty] = useState(false);
  const [type, setType] = useState<LlmBackendId>(backend?.type ?? DEFAULT_LLM_BACKEND);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const test = useTest();

  const editing = backend !== null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        // Changed-only: an untouched key field must not overwrite the stored key
        // with an empty one, which is why `keyDirty` exists rather than a compare.
        const patch: Record<string, unknown> = {
          ...(name.trim() !== backend.name ? { name: name.trim() } : {}),
          ...(baseUrl.trim() !== backend.baseUrl ? { baseUrl: baseUrl.trim() } : {}),
          ...(keyDirty ? { apiKey: apiKey.trim() === "" ? null : apiKey.trim() } : {}),
          ...(type !== backend.type ? { type } : {}),
        };
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        const res = await fetch(`/api/backends/${encodeURIComponent(backend.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          setError(await readApiError(res));
          return;
        }
        const { data } = (await res.json()) as {
          data: { backend: Backend; clearedModels: string[] };
        };
        onSaved(data.clearedModels);
      } else {
        const res = await fetch("/api/backends", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            baseUrl: baseUrl.trim(),
            ...(apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
            type,
          }),
        });
        if (!res.ok) {
          setError(await readApiError(res));
          return;
        }
        onSaved([]);
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
      title={editing ? `Edit ${backend.name}` : "New backend"}
      description="An OpenAI-compatible endpoint the Settings roles can point at."
      footer={
        <>
          {error ? <p className="mr-auto text-sm text-danger">{error}</p> : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={busy || name.trim() === "" || baseUrl.trim() === ""}
          >
            {busy ? "Saving…" : editing ? "Save changes" : "Create backend"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="backend-name" label="Name" hint="How Settings refers to this endpoint.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Home Ollama"
              autoFocus
            />
          )}
        </Field>
        <Field
          id="backend-url"
          label="OpenAI-compatible API URL"
          hint="e.g. https://api.openai.com/v1 or http://localhost:11434/v1"
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="url"
              inputMode="url"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                test.reset();
              }}
              placeholder="https://api.openai.com/v1"
            />
          )}
        </Field>
        <Field
          id="backend-key"
          label="API key"
          hint={
            editing
              ? "Stored securely; never shown again. Leave untouched to keep the current key; clear the field to remove it."
              : "Optional — required by hosted providers, not by local ones. Stored securely; never shown again."
          }
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setKeyDirty(true);
                test.reset();
              }}
              placeholder={
                editing && backend.apiKeyConfigured && !keyDirty
                  ? "•••••••• (configured)"
                  : "optional"
              }
            />
          )}
        </Field>
        <BackendTypeField
          idPrefix="backendDialog"
          value={type}
          onChange={setType}
          baseUrl={baseUrl.trim() === "" ? null : baseUrl.trim()}
        />
        <TestConnection
          state={test.state}
          disabled={baseUrl.trim() === ""}
          onTest={() =>
            void test.run({
              ...(editing ? { backendId: backend.id } : {}),
              baseUrl: baseUrl.trim(),
              ...(keyDirty || !editing
                ? { apiKey: apiKey.trim() === "" ? null : apiKey.trim() }
                : {}),
              type,
            })
          }
        />
      </div>
    </Modal>
  );
}

function BackendCard({
  backend,
  inUseBy,
  onEdit,
  onDelete,
}: {
  backend: Backend;
  inUseBy: string[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const test = useTest();

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle className="truncate">{backend.name}</CardTitle>
          <Badge>{llmBackendLabel(backend.type)}</Badge>
          {inUseBy.length > 0 ? (
            <Badge tone="success" dot>
              In use: {inUseBy.join(", ")}
            </Badge>
          ) : null}
        </div>
        <CardAction>
          <Button
            size="icon"
            variant="ghost"
            onClick={onEdit}
            aria-label={`Edit ${backend.name}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            aria-label={`Delete ${backend.name}`}
          >
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="truncate font-mono text-sm text-muted">{backend.baseUrl}</p>
        <p className="text-sm text-faint">
          {backend.apiKeyConfigured ? "API key configured" : "No API key"}
        </p>
        <TestConnection state={test.state} onTest={() => void test.run({ backendId: backend.id })} />
      </CardContent>
    </Card>
  );
}

export function BackendsManager({
  backends,
  inUse,
}: {
  backends: Backend[];
  /** Settings roles pointing at each backend id (for the in-use badge). */
  inUse: Record<string, string[]>;
}) {
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [state, setState] = useState<DialogState>({ kind: "closed" });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(backend: Backend) {
    const roles = inUse[backend.id] ?? [];
    const ok = await confirm({
      title: `Delete "${backend.name}"?`,
      // The in-use list is the whole reason this confirm is worth reading: it is
      // the difference between deleting a spare and unplugging the chat model.
      body:
        roles.length > 0
          ? `It is currently used by: ${roles.join(", ")}. Those roles will have no endpoint until you point them somewhere else.`
          : "The endpoint is removed from the catalog. This cannot be undone.",
      confirmLabel: "Delete backend",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    try {
      const res = await fetch(`/api/backends/${encodeURIComponent(backend.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    }
  }

  return (
    <div className="space-y-6">
      {/* Reported here rather than on the card: the save closes the dialog and
          the models it cleared belong to Settings roles, not to this row. */}
      {notice ? <p className="text-sm text-warning">{notice}</p> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {backends.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No backends yet"
          description="Add an OpenAI-compatible endpoint, then pick it for the chat and other roles in Settings."
        />
      ) : (
        <div className="space-y-4">
          {backends.map((backend) => (
            <BackendCard
              key={backend.id}
              backend={backend}
              inUseBy={inUse[backend.id] ?? []}
              onEdit={() => setState({ kind: "edit", backend })}
              onDelete={() => void remove(backend)}
            />
          ))}
        </div>
      )}

      <Fab
        label="New backend"
        icon={<Plus className="h-4 w-4" />}
        onClick={() => setState({ kind: "create" })}
      />

      {state.kind !== "closed" ? (
        <BackendDialog
          key={state.kind === "edit" ? state.backend.id : "new"}
          backend={state.kind === "edit" ? state.backend : null}
          onClose={() => setState({ kind: "closed" })}
          onSaved={(clearedModels) =>
            setNotice(
              clearedModels.length > 0
                ? `Cleared ${clearedModels.join(", ")} — not served by the new endpoint. Pick replacements in Settings when ready.`
                : null,
            )
          }
        />
      ) : null}

      {confirmDialog}
    </div>
  );
}
