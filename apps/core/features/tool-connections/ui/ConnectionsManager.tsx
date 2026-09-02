"use client";

import { Plug, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  Fab,
  Field,
  Input,
  Modal,
  Select,
  Switch,
  useConfirm,
} from "@/components/ui";
import { Timestamp } from "@/components/time/Timestamp";
import { fetchTransports, type TransportSummary } from "@/components/transports/api";
import type { ApiErrorBody } from "@/lib/api-error";
import { MAX_CONNECTIONS, type ToolConnection } from "../server/schema";

/**
 * Tool connections manager. Client Component: add a remote MCP server, scope
 * it, discover what it offers, and apply that as the toolset the model sees.
 *
 * The two verbs are deliberately separate (user decision, 2026-08-28).
 * **Discover** asks the server and shows what changed; **Apply** is what moves
 * the offered toolset. Until Apply is pressed the model keeps being offered
 * exactly what it was offered before — which is why a connection can be
 * discovered, read, and thought about without the running conversations
 * noticing anything.
 */

/** An assistant, as the selection picker needs it. */
export interface AssistantOption {
  id: string;
  name: string;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** One header row in the editor; blank names are dropped on save. */
interface HeaderDraft {
  name: string;
  value: string;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; connection: ToolConnection };

/** What a connection's scope comes to, in words. */
function scopeLabel(connection: ToolConnection, assistants: AssistantOption[]): string {
  const where = connection.appScope ? `${connection.appScope} turns` : "every source";
  if (connection.allAssistants) return `${where}, every assistant`;
  if (connection.assistantIds.length === 0) return `${where}, no assistant selected`;
  const names = connection.assistantIds
    .map((id) => assistants.find((a) => a.id === id)?.name ?? id)
    .join(", ");
  return `${where}, ${names}`;
}

/** The drift a discovery found, as a line the operator can act on. */
function driftLabel(connection: ToolConnection): string | null {
  const drift = connection.drift;
  if (!drift) return null;
  const parts: string[] = [];
  if (drift.added.length) parts.push(`${drift.added.length} new`);
  if (drift.changed.length) parts.push(`${drift.changed.length} changed`);
  if (drift.removed.length) parts.push(`${drift.removed.length} gone`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function ConnectionDialog({
  connection,
  assistants,
  onClose,
}: {
  connection: ToolConnection | null;
  assistants: AssistantOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const editing = connection !== null;
  const [name, setName] = useState(connection?.name ?? "");
  const [slug, setSlug] = useState(connection?.slug ?? "");
  const [endpointUrl, setEndpointUrl] = useState(connection?.endpointUrl ?? "");
  // Values are never sent to the browser, so an editor starts from the names
  // it has and re-entering one is how it is changed.
  const [headers, setHeaders] = useState<HeaderDraft[]>(
    connection && connection.authHeaderNames.length > 0
      ? connection.authHeaderNames.map((headerName) => ({ name: headerName, value: "" }))
      : [{ name: "", value: "" }],
  );
  const [appScope, setAppScope] = useState<string>(connection?.appScope ?? "");
  // The scope options are the registered transports plus the web chat — the
  // roster, never a list typed into the form.
  const [transports, setTransports] = useState<TransportSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchTransports()
      .then((rows) => {
        if (!cancelled) setTransports(rows);
      })
      .catch(() => {
        // The select still offers "every source" and the web chat.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [allAssistants, setAllAssistants] = useState(connection?.allAssistants ?? true);
  const [assistantIds, setAssistantIds] = useState<string[]>(connection?.assistantIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const managed = connection?.managed ?? false;
  const headerEntries = headers.filter((header) => header.name.trim() !== "");
  const headersTouched = headerEntries.some((header) => header.value !== "");

  async function save() {
    setBusy(true);
    setError(null);
    const authHeaders = Object.fromEntries(
      headerEntries.map((header) => [header.name.trim(), header.value]),
    );
    const body = {
      ...(managed ? {} : { name: name.trim(), slug: slug.trim(), endpointUrl: endpointUrl.trim() }),
      ...(managed || !headersTouched ? {} : { authHeaders }),
      appScope: appScope === "" ? null : appScope,
      allAssistants,
      assistantIds: allAssistants ? [] : assistantIds,
    };
    try {
      const res = await fetch(
        editing ? `/api/tool-connections/${encodeURIComponent(connection.id)}` : "/api/tool-connections",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
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

  const complete = managed || (name.trim() !== "" && slug.trim() !== "" && endpointUrl.trim() !== "");

  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      title={editing ? `Edit ${connection.name}` : "New tool connection"}
      description="A remote MCP server whose tools the assistants may call. Nothing is offered to the model until its discovered tools are applied."
      footer={
        <>
          {error ? <p className="mr-auto text-sm text-danger">{error}</p> : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !complete}>
            {busy ? "Saving…" : editing ? "Save changes" : "Add connection"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {managed && connection ? (
          <p className="text-sm text-muted">
            {connection.name} is provided by the hub: its address and credentials come from
            configuration and its tools follow the deployed release. What is yours here is where
            it applies.
          </p>
        ) : (
          <>
            <Field id="connection-name" label="Name">
              {({ id }) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Weather service"
                  autoFocus
                />
              )}
            </Field>
            <Field
              id="connection-slug"
              label="Slug"
              hint="Prefixes this server's tool names, so two servers can both have a “search”."
            >
              {({ id }) => (
                <Input
                  id={id}
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="e.g. weather"
                />
              )}
            </Field>
            <Field id="connection-endpoint" label="Endpoint URL">
              {({ id }) => (
                <Input
                  id={id}
                  value={endpointUrl}
                  onChange={(e) => setEndpointUrl(e.target.value)}
                  placeholder="https://tools.example.com/mcp"
                />
              )}
            </Field>
            <Field
              id="connection-headers"
              label="Auth headers"
              hint="Sent on every request. Stored values are never shown again — type one to replace it."
            >
              {() => (
                <div className="space-y-2">
                  {headers.map((header, index) => (
                    <div key={index} className="flex gap-2">
                      <Input
                        value={header.name}
                        onChange={(e) =>
                          setHeaders((rows) =>
                            rows.map((row, i) =>
                              i === index ? { ...row, name: e.target.value } : row,
                            ),
                          )
                        }
                        placeholder="Authorization"
                        aria-label={`Header ${index + 1} name`}
                      />
                      <Input
                        type="password"
                        value={header.value}
                        onChange={(e) =>
                          setHeaders((rows) =>
                            rows.map((row, i) =>
                              i === index ? { ...row, value: e.target.value } : row,
                            ),
                          )
                        }
                        placeholder={
                          connection?.authHeaderNames.includes(header.name.trim())
                            ? "unchanged"
                            : "Bearer …"
                        }
                        aria-label={`Header ${index + 1} value`}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove header ${index + 1}`}
                        onClick={() =>
                          setHeaders((rows) => rows.filter((_, i) => i !== index))
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setHeaders((rows) => [...rows, { name: "", value: "" }])}
                  >
                    Add header
                  </Button>
                </div>
              )}
            </Field>
          </>
        )}

        <Field
          id="connection-scope"
          label="Where it applies"
          hint="A source app's turns only, or every conversation."
        >
          {({ id }) => (
            <Select id={id} value={appScope} onChange={(e) => setAppScope(e.target.value)}>
              <option value="">Every source</option>
              {transports.map((transport) => (
                <option key={transport.id} value={transport.id}>
                  {transport.name} turns only
                </option>
              ))}
              {appScope !== "" && !transports.some((transport) => transport.id === appScope) && appScope !== "chat" ? (
                <option value={appScope}>{appScope} turns only</option>
              ) : null}
              <option value="chat">Web chat turns only</option>
            </Select>
          )}
        </Field>

        <Field id="connection-assistants" label="Which assistants may call it">
          {() => (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={allAssistants}
                  onChange={(e) => setAllAssistants(e.target.checked)}
                />
                Every assistant
              </label>
              {allAssistants ? null : (
                <div className="space-y-1 border-l border-border pl-3">
                  {assistants.length === 0 ? (
                    <p className="text-sm text-faint">No assistants yet.</p>
                  ) : (
                    assistants.map((assistant) => (
                      <label
                        key={assistant.id}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          checked={assistantIds.includes(assistant.id)}
                          onChange={(e) =>
                            setAssistantIds((ids) =>
                              e.target.checked
                                ? [...ids, assistant.id]
                                : ids.filter((id) => id !== assistant.id),
                            )
                          }
                          aria-label={assistant.name}
                        />
                        {assistant.name}
                      </label>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </Field>
      </div>
    </Modal>
  );
}

function ConnectionCard({
  connection,
  assistants,
  onEdit,
  onDelete,
}: {
  connection: ToolConnection;
  assistants: AssistantOption[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"discover" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drift = driftLabel(connection);

  async function act(action: "discover" | "apply") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(
        `/api/tool-connections/${encodeURIComponent(connection.id)}/${action}`,
        { method: "POST" },
      );
      if (!res.ok) setError(await readError(res));
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle className="truncate">{connection.name}</CardTitle>
          <code className="text-xs text-muted">{connection.slug}</code>
          {connection.managed ? <Badge tone="info">provided by the hub</Badge> : null}
          {connection.enabled ? null : <Badge tone="neutral">disabled</Badge>}
          {drift ? <Badge tone="warning">{drift}</Badge> : null}
        </div>
        <CardAction>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void act("discover")}
            disabled={busy !== null}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            {busy === "discover" ? "Discovering…" : "Discover"}
          </Button>
          <Button
            size="sm"
            variant={drift ? "primary" : "outline"}
            onClick={() => void act("apply")}
            disabled={busy !== null || !connection.discoveredTools}
          >
            <Upload className="h-4 w-4" aria-hidden />
            {busy === "apply" ? "Applying…" : "Apply"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          {connection.managed ? null : (
            <Button
              size="icon"
              variant="ghost"
              onClick={onDelete}
              aria-label={`Delete ${connection.name}`}
            >
              <Trash2 className="h-4 w-4 text-danger" />
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm text-muted">
          <code className="text-xs">{connection.endpointUrl}</code>
          <span className="mx-2 text-faint">·</span>
          {scopeLabel(connection, assistants)}
          {connection.authHeaderNames.length > 0 ? (
            <>
              <span className="mx-2 text-faint">·</span>
              {connection.authHeaderNames.join(", ")}
            </>
          ) : null}
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {connection.lastError ? (
          <p className="text-sm text-danger">Last discovery failed: {connection.lastError}</p>
        ) : null}

        <div className="text-sm">
          {connection.tools.length === 0 ? (
            <p className="text-faint">
              Nothing offered yet — discover this server, then apply what it reports.
            </p>
          ) : (
            <p className="text-muted">
              Offering {connection.tools.length} tool
              {connection.tools.length === 1 ? "" : "s"}
              {connection.lastDiscoveredAt ? (
                <>
                  {" "}
                  · last checked <Timestamp iso={connection.lastDiscoveredAt} />
                </>
              ) : null}
            </p>
          )}
        </div>

        {drift ? (
          <p className="text-sm text-warning">
            The server now offers something else. Apply to hand the new set to the assistants;
            until then they keep being offered the {connection.tools.length} above.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ConnectionsManager({
  connections,
  assistants,
}: {
  connections: ToolConnection[];
  assistants: AssistantOption[];
}) {
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [state, setState] = useState<DialogState>({ kind: "closed" });
  const [error, setError] = useState<string | null>(null);

  const atLimit = connections.length >= MAX_CONNECTIONS;

  async function remove(connection: ToolConnection) {
    const ok = await confirm({
      title: `Delete "${connection.name}"?`,
      body: `Its ${connection.tools.length} tools stop being offered immediately, and the assistants lose whatever they did with them.`,
      confirmLabel: "Delete connection",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    try {
      const res = await fetch(`/api/tool-connections/${encodeURIComponent(connection.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    }
  }

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {connections.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No tool connections"
          description="Add a remote MCP server to give the assistants tools this hub does not ship with."
        />
      ) : (
        connections.map((connection) => (
          <ConnectionCard
            key={connection.id}
            connection={connection}
            assistants={assistants}
            onEdit={() => setState({ kind: "edit", connection })}
            onDelete={() => void remove(connection)}
          />
        ))
      )}

      <Fab
        label="New connection"
        icon={<Plus className="h-4 w-4" />}
        onClick={() => setState({ kind: "create" })}
        disabled={atLimit}
        status={atLimit ? { tone: "muted", text: `Limit of ${MAX_CONNECTIONS} reached` } : null}
      />

      {state.kind !== "closed" ? (
        <ConnectionDialog
          key={state.kind === "edit" ? state.connection.id : "new"}
          connection={state.kind === "edit" ? state.connection : null}
          assistants={assistants}
          onClose={() => setState({ kind: "closed" })}
        />
      ) : null}

      {confirmDialog}
    </div>
  );
}
