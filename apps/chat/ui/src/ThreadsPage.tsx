"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ImagePlus, MessagesSquare, Plus, Send, Trash2, X } from "lucide-react";

import type { ChatThread, ChatThreadMessage, ChatThreadTurn } from "@assistant-hub/contracts";
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LiveIndicator,
  PageHeader,
  Timestamp,
  apiFetch,
  appPageHref,
  cn,
  useLiveEvent,
  type AppPageProps,
} from "@assistant-hub/ui";

/**
 * The web-chat page the shell mounts at `/apps/chat` — this app's own view,
 * built from the shared dashboard primitives so it reads like every other
 * page, and fed only through the core proxy (`/api/chat/*`), never by
 * importing this app's server code (PLAN.md, "Dashboard composition").
 *
 * Two panes: the threads this app carries, and the conversation the URL
 * segment selects (`/apps/chat/<threadId>`), so a thread can be linked to and
 * come back on a reload. Sending is message-at-once — the reply arrives when
 * the turn produces it, over the same SSE stream every other live surface
 * uses, not as streamed tokens (PLAN.md).
 */

interface Assistant {
  id: string;
  name: string;
}

export function ChatThreadsPage({ segments }: AppPageProps) {
  const router = useRouter();
  const selectedId = segments[0] ?? null;

  const [threads, setThreads] = useState<ChatThread[] | null>(null);
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadThreads = useCallback(async () => {
    try {
      const data = await apiFetch<{ threads: ChatThread[] }>("/api/chat/threads");
      setThreads(data.threads);
      setError(null);
    } catch (err) {
      setThreads([]);
      setError(err instanceof Error ? err.message : "Could not reach the server");
    }
  }, []);

  useEffect(() => {
    void loadThreads();
    void apiFetch<{ assistants: Assistant[] }>("/api/assistants")
      .then((data) => setAssistants(data.assistants))
      .catch(() => setAssistants([]));
  }, [loadThreads]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Web chat"
        description="Threads with your assistants, in the dashboard itself."
        actions={<LiveIndicator topic="threads" onEvent={loadThreads} />}
      />

      {error ? (
        <EmptyState
          icon={MessagesSquare}
          title="The chat service did not answer"
          description={error}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <ThreadList
            threads={threads}
            assistants={assistants}
            selectedId={selectedId}
            onCreated={async (thread) => {
              await loadThreads();
              router.push(appPageHref("chat", thread.id));
            }}
          />
          {selectedId ? (
            <Conversation
              key={selectedId}
              threadId={selectedId}
              assistants={assistants}
              onChanged={loadThreads}
              onDeleted={async () => {
                await loadThreads();
                router.push(appPageHref("chat"));
              }}
            />
          ) : (
            <EmptyState
              icon={MessagesSquare}
              title={threads?.length ? "Pick a thread" : "No threads yet"}
              description={
                threads?.length
                  ? "Open one on the left to read it and answer."
                  : "Start one with an assistant to talk to it here."
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The thread column: what exists, and how to start one more. */
function ThreadList({
  threads,
  assistants,
  selectedId,
  onCreated,
}: {
  threads: ChatThread[] | null;
  assistants: Assistant[];
  selectedId: string | null;
  onCreated: (thread: ChatThread) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [assistantId, setAssistantId] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // The first assistant is the obvious default; a deployment with one
  // assistant then needs no choice at all.
  useEffect(() => {
    if (!assistantId && assistants.length > 0) setAssistantId(assistants[0].id);
  }, [assistants, assistantId]);

  const create = async () => {
    if (!name.trim() || !assistantId) return;
    setBusy(true);
    setFailure(null);
    try {
      const data = await apiFetch<{ thread: ChatThread }>("/api/chat/threads", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), assistantId }),
      });
      setName("");
      await onCreated(data.thread);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Could not create the thread");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Card className="space-y-3 p-4">
        <Field id="chat-thread-name" label="New thread">
          {({ id }) => (
            <Input
              id={id}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What is it about?"
              maxLength={120}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
              }}
            />
          )}
        </Field>
        {assistants.length > 1 ? (
          <Field
            id="chat-thread-assistant"
            label="Assistant"
            hint="Fixed for the life of the thread."
          >
            {({ id, describedBy }) => (
              <select
                id={id}
                aria-describedby={describedBy}
                value={assistantId}
                onChange={(e) => setAssistantId(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm"
              >
                {assistants.map((assistant) => (
                  <option key={assistant.id} value={assistant.id}>
                    {assistant.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        <Button
          onClick={() => void create()}
          disabled={busy || !name.trim() || !assistantId}
          className="w-full"
        >
          <Plus className="h-4 w-4" />
          {busy ? "Starting…" : "Start thread"}
        </Button>
        {assistants.length === 0 ? (
          <p className="text-xs text-muted">
            No assistants yet — create one first, and a thread can be bound to it.
          </p>
        ) : null}
        {failure ? <p className="text-xs text-danger">{failure}</p> : null}
      </Card>

      {threads === null ? <p className="text-sm text-muted">Loading threads…</p> : null}

      {threads?.length ? (
        <ul className="space-y-2">
          {threads.map((thread) => (
            <li key={thread.id}>
              <Link href={appPageHref("chat", thread.id)} className="block">
                <Card
                  interactive
                  className={cn(
                    "px-4 py-3",
                    thread.id === selectedId && "border-primary/40 bg-surface-hover",
                  )}
                >
                  <p className="truncate text-sm font-medium">{thread.name}</p>
                  <p className="flex items-center gap-2 text-xs text-muted">
                    <span>
                      {thread.messageCount}{" "}
                      {thread.messageCount === 1 ? "message" : "messages"}
                    </span>
                    <span aria-hidden>·</span>
                    <Timestamp iso={thread.lastMessageAt} fallback="not started" />
                  </p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One thread: its transcript and the box to answer in. */
function Conversation({
  threadId,
  assistants,
  onChanged,
  onDeleted,
}: {
  threadId: string;
  assistants: Assistant[];
  onChanged: () => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
}) {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [messages, setMessages] = useState<ChatThreadMessage[]>([]);
  const [turn, setTurn] = useState<ChatThreadTurn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [image, setImage] = useState<{ name: string; dataBase64: string; mimeType: string } | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{
        thread: ChatThread;
        messages: ChatThreadMessage[];
        turn: ChatThreadTurn | null;
      }>(`/api/chat/threads/${encodeURIComponent(threadId)}`);
      setThread(data.thread);
      setMessages(data.messages);
      setTurn(data.turn);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the thread");
    }
  }, [threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The reply lands at the bottom; follow it there, but never fight a reader
  // who scrolled up on purpose — `nearest` only scrolls when it must.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, turn?.sourceMessageId]);

  // Live: the chat app pings this topic when a thread changes, which includes
  // the assistant's reply arriving after the turn ran. The page's own pill
  // owns pausing; this subscription is what makes an answer appear without
  // anyone reloading.
  useLiveEvent("threads", load);

  const send = async () => {
    const text = draft.trim();
    // A picture with no words is a message too — "what is this?" is implied.
    if (!text && !image) return;
    setSending(true);
    setError(null);
    try {
      await apiFetch(`/api/chat/threads/${encodeURIComponent(threadId)}/messages`, {
        method: "POST",
        body: JSON.stringify({
          text,
          ...(image ? { image: { dataBase64: image.dataBase64, mimeType: image.mimeType } } : {}),
        }),
      });
      setDraft("");
      setImage(null);
      await load();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The message was not sent");
    } finally {
      setSending(false);
    }
  };

  const remove = async () => {
    try {
      await apiFetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
      await onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The thread was not deleted");
    }
  };

  const assistantName =
    assistants.find((a) => a.id === thread?.assistantId)?.name ?? "this thread's assistant";

  return (
    <Card className="flex h-[calc(100vh-16rem)] min-h-96 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{thread?.name ?? "Thread"}</p>
          <p className="truncate text-xs text-muted">with {assistantName}</p>
        </div>
        <Button
          variant={confirmingDelete ? "danger" : "ghost"}
          size="sm"
          onClick={() => (confirmingDelete ? void remove() : setConfirmingDelete(true))}
          onBlur={() => setConfirmingDelete(false)}
        >
          <Trash2 className="h-4 w-4" />
          {confirmingDelete ? "Delete for good?" : "Delete"}
        </Button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {messages.length === 0 ? (
          <p className="text-sm text-muted">Nothing said yet. Say something.</p>
        ) : null}
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "max-w-[80%] rounded-xl px-4 py-2 text-sm whitespace-pre-wrap",
              message.role === "user"
                ? "ml-auto bg-primary/15 text-foreground"
                : "bg-surface-2 text-foreground",
            )}
          >
            {message.media ? (
              <figure className="mb-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/chat/media/${encodeURIComponent(message.media.id)}`}
                  alt={message.media.description ?? "Uploaded image"}
                  className="max-h-64 rounded-lg"
                />
                <figcaption
                  // The description can run to paragraphs — it is what the
                  // assistant reads, not what the reader needs under a
                  // thumbnail. Two lines here, the whole text on hover.
                  className="mt-1 line-clamp-2 text-[10px] text-faint"
                  title={message.media.description ?? undefined}
                >
                  {message.media.status === "described"
                    ? message.media.description
                    : message.media.status === "unavailable"
                      ? "the assistant could not read this image"
                      : "the assistant is still looking at this…"}
                </figcaption>
              </figure>
            ) : null}
            {message.content}
            <span className="mt-1 block text-[10px] text-faint">
              <Timestamp iso={message.sentAt} timeOnly />
            </span>
          </div>
        ))}
        {turn ? (
          <p className="flex items-center gap-2 text-xs text-muted">
            <span
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none"
              aria-hidden
            />
            {turn.activity ? `Working — ${turn.activity}…` : "Thinking…"}
          </p>
        ) : null}
        <div ref={bottom} />
      </div>

      <footer className="space-y-2 border-t border-border px-5 py-3">
        {error ? <p className="text-xs text-danger">{error}</p> : null}
        {image ? (
          <p className="flex items-center gap-2 text-xs text-muted">
            <ImagePlus className="h-3.5 w-3.5" />
            <span className="truncate">{image.name}</span>
            <button
              type="button"
              onClick={() => setImage(null)}
              className="text-faint hover:text-foreground"
              aria-label="Remove the attached image"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </p>
        ) : null}
        <div className="flex items-end gap-2">
          <label
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border text-muted hover:text-foreground"
            title="Attach an image"
          >
            <ImagePlus className="h-4 w-4" />
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                try {
                  setImage({
                    name: file.name,
                    mimeType: file.type || "image/jpeg",
                    dataBase64: await readAsBase64(file),
                  });
                } catch {
                  setError("That file could not be read");
                }
              }}
            />
          </label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, shift+Enter breaks the line — the convention
              // every chat box in the world already taught the operator.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            maxLength={10_000}
            placeholder="Write a message…"
            className="flex-1 resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
          />
          <Button onClick={() => void send()} disabled={sending || (!draft.trim() && !image)}>
            <Send className="h-4 w-4" />
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </footer>
    </Card>
  );
}

/** Read a picked file as base64 (the payload the chat app normalizes). */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      // Strip the data-URI prefix; the app wants the payload, not the wrapper.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}
