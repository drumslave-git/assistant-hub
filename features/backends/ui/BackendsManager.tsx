"use client";

import { Check, Pencil, Plug, Plus, Server, Trash2, X } from "lucide-react";
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
  Field,
  Input,
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
 * server-rendered list. Built from the shared UI-kit primitives.
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

function CreateForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [type, setType] = useState<LlmBackendId>(DEFAULT_LLM_BACKEND);
  const [state, setState] = useState<"idle" | "saving" | { error: string }>("idle");
  const test = useTest();

  async function create() {
    setState("saving");
    try {
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
        setState({ error: await readApiError(res) });
        return;
      }
      setName("");
      setBaseUrl("");
      setApiKey("");
      setType(DEFAULT_LLM_BACKEND);
      test.reset();
      setState("idle");
      router.refresh();
    } catch {
      setState({ error: "Network error — could not reach the server" });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New backend</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field id="new-backend-name" label="Name" hint="How Settings refers to this endpoint.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setState("idle");
              }}
              placeholder="e.g. Home Ollama"
            />
          )}
        </Field>
        <Field
          id="new-backend-url"
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
                setState("idle");
              }}
              placeholder="https://api.openai.com/v1"
            />
          )}
        </Field>
        <Field
          id="new-backend-key"
          label="API key"
          hint="Optional — required by hosted providers, not by local ones. Stored securely; never shown again."
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
                test.reset();
              }}
              placeholder="optional"
            />
          )}
        </Field>
        <BackendTypeField
          idPrefix="newBackend"
          value={type}
          onChange={setType}
          baseUrl={baseUrl.trim() === "" ? null : baseUrl.trim()}
        />
        <TestConnection
          state={test.state}
          disabled={baseUrl.trim() === ""}
          onTest={() =>
            void test.run({
              baseUrl: baseUrl.trim(),
              ...(apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
            })
          }
        />
        <div className="flex items-center gap-3">
          <Button
            onClick={create}
            disabled={name.trim() === "" || baseUrl.trim() === "" || state === "saving"}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            {state === "saving" ? "Creating…" : "Create backend"}
          </Button>
          {typeof state === "object" ? (
            <span className="text-sm text-danger">{state.error}</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function BackendCard({ backend, inUseBy }: { backend: Backend; inUseBy: string[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(backend.name);
  const [baseUrl, setBaseUrl] = useState(backend.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [keyDirty, setKeyDirty] = useState(false);
  const [type, setType] = useState<LlmBackendId>(backend.type);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearedModels, setClearedModels] = useState<string[]>([]);
  const test = useTest();

  function resetEdit() {
    setName(backend.name);
    setBaseUrl(backend.baseUrl);
    setApiKey("");
    setKeyDirty(false);
    setType(backend.type);
    setError(null);
    setEditing(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setClearedModels([]);
    try {
      const patch: Record<string, unknown> = {
        ...(name.trim() !== backend.name ? { name: name.trim() } : {}),
        ...(baseUrl.trim() !== backend.baseUrl ? { baseUrl: baseUrl.trim() } : {}),
        ...(keyDirty ? { apiKey: apiKey.trim() === "" ? null : apiKey.trim() } : {}),
        ...(type !== backend.type ? { type } : {}),
      };
      if (Object.keys(patch).length === 0) {
        setEditing(false);
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
      setClearedModels(data.clearedModels);
      setEditing(false);
      setApiKey("");
      setKeyDirty(false);
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete backend "${backend.name}"? This cannot be undone.`)) return;
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Edit backend</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field id={`edit-name-${backend.id}`} label="Name">
            {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field id={`edit-url-${backend.id}`} label="OpenAI-compatible API URL">
            {({ id }) => (
              <Input
                id={id}
                type="url"
                inputMode="url"
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  test.reset();
                }}
              />
            )}
          </Field>
          <Field
            id={`edit-key-${backend.id}`}
            label="API key"
            hint="Stored securely; never shown again. Leave untouched to keep the current key; clear the field to remove it."
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
                placeholder={backend.apiKeyConfigured && !keyDirty ? "•••••••• (configured)" : "optional"}
              />
            )}
          </Field>
          <BackendTypeField
            idPrefix={`edit-${backend.id}`}
            value={type}
            onChange={setType}
            baseUrl={baseUrl.trim() === "" ? null : baseUrl.trim()}
          />
          <TestConnection
            state={test.state}
            disabled={baseUrl.trim() === ""}
            onTest={() =>
              void test.run({
                backendId: backend.id,
                baseUrl: baseUrl.trim(),
                ...(keyDirty ? { apiKey: apiKey.trim() === "" ? null : apiKey.trim() } : {}),
              })
            }
          />
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </CardContent>
        <CardFooter>
          <Button
            size="sm"
            onClick={save}
            disabled={busy || name.trim() === "" || baseUrl.trim() === ""}
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
            onClick={() => setEditing(true)}
            disabled={busy}
            aria-label={`Edit ${backend.name}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={remove}
            disabled={busy}
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
        {clearedModels.length > 0 ? (
          <p className="text-sm text-warning">
            Cleared {clearedModels.join(", ")} — not served by the new endpoint. Pick replacements
            in Settings when ready.
          </p>
        ) : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
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
  return (
    <div className="space-y-6">
      <CreateForm />

      {backends.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No backends yet"
          description="Add an OpenAI-compatible endpoint above, then pick it for the chat and other roles in Settings."
        />
      ) : (
        <div className="space-y-4">
          {backends.map((backend) => (
            <BackendCard key={backend.id} backend={backend} inUseBy={inUse[backend.id] ?? []} />
          ))}
        </div>
      )}
    </div>
  );
}
