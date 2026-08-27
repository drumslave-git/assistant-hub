"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ImagePlus, MessagesSquare, Mic, PenSquare, Send, Square, Trash2, X } from "lucide-react";

import type { ChatThread, ChatThreadMessage, ChatThreadTurn } from "@assistant-hub/contracts";
import {
  Button,
  Card,
  EmptyState,
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
 * The shape is the one everybody already knows from a chat app: chats down the
 * left with "New chat" at the top, the conversation on the right, the composer
 * at the bottom of it. A new chat is a blank conversation, not a form — the
 * thread is created by the first message and NAMED from that exchange by the
 * core (`server/turn/name-conversation.ts`), so nobody has to title a
 * conversation before having it.
 *
 * Sending is message-at-once: the reply arrives when the turn produces it,
 * over the same SSE stream every other live surface uses, not as streamed
 * tokens (PLAN.md).
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
    <div className="space-y-4">
      <PageHeader
        title="Web chat"
        description="Talk to your assistants in the dashboard itself."
        actions={<LiveIndicator topic="threads" onEvent={loadThreads} />}
      />

      {error ? (
        <EmptyState
          icon={MessagesSquare}
          title="The chat service did not answer"
          description={error}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <ChatSidebar threads={threads} selectedId={selectedId} />
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
            <NewConversation
              assistants={assistants}
              onStarted={async (thread) => {
                await loadThreads();
                router.push(appPageHref("chat", thread.id));
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The chat column: a new chat at the top, everything else under it. */
function ChatSidebar({
  threads,
  selectedId,
}: {
  threads: ChatThread[] | null;
  selectedId: string | null;
}) {
  return (
    <div className="flex max-h-[calc(100vh-13rem)] flex-col gap-2">
      <Button asChild variant="outline" className="w-full justify-start">
        <Link href={appPageHref("chat")}>
          <PenSquare className="h-4 w-4" />
          New chat
        </Link>
      </Button>

      <nav className="min-h-0 flex-1 overflow-y-auto">
        {threads === null ? <p className="px-2 text-sm text-muted">Loading…</p> : null}
        {threads?.length === 0 ? (
          <p className="px-2 py-6 text-sm text-muted">
            No chats yet. The first thing you say starts one.
          </p>
        ) : null}
        <ul className="space-y-0.5">
          {threads?.map((thread) => (
            <li key={thread.id}>
              <Link
                href={appPageHref("chat", thread.id)}
                className={cn(
                  "block truncate rounded-lg px-3 py-2 text-sm transition-colors",
                  thread.id === selectedId
                    ? "bg-surface-2 font-medium text-foreground"
                    : "text-muted hover:bg-surface-2 hover:text-foreground",
                )}
                title={thread.name}
              >
                {thread.name}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

/** Shared chrome, so a new chat and an old one are the same column. */
function ConversationShell({
  header,
  children,
  footer,
}: {
  header: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Card className="flex h-[calc(100vh-13rem)] min-h-96 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        {header}
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      <footer className="space-y-2 border-t border-border px-5 py-3">{footer}</footer>
    </Card>
  );
}

/**
 * A chat that does not exist yet: an empty conversation with a composer. The
 * assistant is picked here because it is the one thing fixed for the life of a
 * thread (PLAN.md); everything else about the chat comes from what is said.
 */
function NewConversation({
  assistants,
  onStarted,
}: {
  assistants: Assistant[];
  onStarted: (thread: ChatThread) => void | Promise<void>;
}) {
  const [assistantId, setAssistantId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!assistantId && assistants.length > 0) setAssistantId(assistants[0].id);
  }, [assistants, assistantId]);

  const start = async (draft: Draft) => {
    if (!assistantId) return;
    setBusy(true);
    setError(null);
    try {
      // Create, then speak: the thread exists the moment there is something in
      // it, so an abandoned "New chat" never piles up in the sidebar.
      const created = await apiFetch<{ thread: ChatThread }>("/api/chat/threads", {
        method: "POST",
        body: JSON.stringify({ assistantId }),
      });
      await apiFetch(`/api/chat/threads/${encodeURIComponent(created.thread.id)}/messages`, {
        method: "POST",
        body: JSON.stringify(draftBody(draft)),
      });
      await onStarted(created.thread);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The chat could not be started");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConversationShell
      header={
        assistants.length > 1 ? (
          <label className="flex items-center gap-2 text-xs text-muted">
            Talking to
            <select
              value={assistantId}
              onChange={(e) => setAssistantId(e.target.value)}
              className="h-8 rounded-lg border border-border bg-surface-2 px-2 text-sm text-foreground"
            >
              {assistants.map((assistant) => (
                <option key={assistant.id} value={assistant.id}>
                  {assistant.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-sm font-medium">
            {assistants[0]?.name ?? "No assistant configured"}
          </p>
        )
      }
      footer={
        <Composer
          disabled={busy || !assistantId}
          sending={busy}
          error={error}
          onSend={start}
          placeholder="Say something to start a chat…"
        />
      }
    >
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <MessagesSquare className="h-8 w-8 text-faint" aria-hidden />
        <p className="text-sm text-muted">
          {assistants.length === 0
            ? "Create an assistant first — a chat is always with one."
            : "What can I help with?"}
        </p>
      </div>
    </ConversationShell>
  );
}

/** One chat: its transcript, its live progress, and the box to answer in. */
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
  const [sending, setSending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
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
      setError(err instanceof Error ? err.message : "Could not read the chat");
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

  // Live: the chat app pings this topic when a thread changes — the reply
  // arriving, and the generated title landing a moment after it.
  useLiveEvent("threads", load);

  const send = async (draft: Draft) => {
    setSending(true);
    setError(null);
    try {
      await apiFetch(`/api/chat/threads/${encodeURIComponent(threadId)}/messages`, {
        method: "POST",
        body: JSON.stringify(draftBody(draft)),
      });
      await load();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The message was not sent");
    } finally {
      setSending(false);
    }
  };

  const rename = async (name: string) => {
    setRenaming(null);
    if (!name.trim() || name.trim() === thread?.name) return;
    try {
      await apiFetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim() }),
      });
      await load();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The chat was not renamed");
    }
  };

  const remove = async () => {
    try {
      await apiFetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
      await onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The chat was not deleted");
    }
  };

  const assistantName =
    assistants.find((a) => a.id === thread?.assistantId)?.name ?? "this chat's assistant";

  return (
    <ConversationShell
      header={
        <>
          <div className="min-w-0">
            {renaming !== null ? (
              <input
                autoFocus
                value={renaming}
                onChange={(e) => setRenaming(e.target.value)}
                onBlur={() => void rename(renaming)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void rename(renaming);
                  if (e.key === "Escape") setRenaming(null);
                }}
                maxLength={120}
                className="w-full rounded border border-border bg-surface-2 px-2 py-0.5 text-sm"
                aria-label="Chat name"
              />
            ) : (
              <button
                type="button"
                onClick={() => setRenaming(thread?.name ?? "")}
                className="block max-w-full truncate text-sm font-medium hover:underline"
                title="Click to rename"
              >
                {thread?.name ?? "Chat"}
              </button>
            )}
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
        </>
      }
      footer={<Composer disabled={sending} sending={sending} error={error} onSend={send} />}
    >
      <div className="space-y-3">
        {messages.length === 0 ? (
          <p className="text-sm text-muted">Nothing said yet. Say something.</p>
        ) : null}
        {messages.map((message) => (
          <Message key={message.id} message={message} />
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
    </ConversationShell>
  );
}

/** One line of the transcript, with whatever came attached to it. */
function Message({ message }: { message: ChatThreadMessage }) {
  const media = message.media;
  const mediaUrl = media ? `/api/chat/media/${encodeURIComponent(media.id)}` : null;
  return (
    <div
      className={cn(
        "max-w-[80%] rounded-xl px-4 py-2 text-sm whitespace-pre-wrap",
        message.role === "user"
          ? "ml-auto bg-primary/15 text-foreground"
          : "bg-surface-2 text-foreground",
      )}
    >
      {media && mediaUrl ? (
        media.kind === "voice" ? (
          <audio controls preload="none" src={mediaUrl} className="mb-2 w-full" />
        ) : media.kind === "file" ? (
          <a href={mediaUrl} className="mb-2 block text-xs underline">
            {media.description ?? "the file"}
          </a>
        ) : (
          <figure className="mb-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mediaUrl}
              alt={media.description ?? "Uploaded image"}
              className="max-h-64 rounded-lg"
            />
            <figcaption
              // The description can run to paragraphs — it is what the
              // assistant reads, not what the reader needs under a thumbnail.
              className="mt-1 line-clamp-2 text-[10px] text-faint"
              title={media.description ?? undefined}
            >
              {media.status === "described"
                ? media.description
                : media.status === "unavailable"
                  ? "the assistant could not read this image"
                  : "the assistant is still looking at this…"}
            </figcaption>
          </figure>
        )
      ) : null}
      {message.content}
      <span className="mt-1 block text-[10px] text-faint">
        <Timestamp iso={message.sentAt} timeOnly />
      </span>
    </div>
  );
}

/** What one send carries: words, and at most one thing attached to them. */
interface Draft {
  text: string;
  image?: { name: string; dataBase64: string; mimeType: string } | null;
  audio?: { dataBase64: string; mimeType: string } | null;
}

function draftBody(draft: Draft): Record<string, unknown> {
  return {
    text: draft.text,
    ...(draft.image
      ? { image: { dataBase64: draft.image.dataBase64, mimeType: draft.image.mimeType } }
      : {}),
    ...(draft.audio ? { audio: draft.audio } : {}),
  };
}

/**
 * The box at the bottom: type, attach a picture, record a voice note. Enter
 * sends and shift+Enter breaks the line — the convention every chat box in the
 * world already taught the operator.
 */
function Composer({
  disabled,
  sending,
  error,
  onSend,
  placeholder = "Write a message…",
}: {
  disabled: boolean;
  sending: boolean;
  error: string | null;
  onSend: (draft: Draft) => void | Promise<void>;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [image, setImage] = useState<Draft["image"]>(null);
  const [audio, setAudio] = useState<Draft["audio"]>(null);
  const [recording, setRecording] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);

  const empty = !text.trim() && !image && !audio;

  const send = async () => {
    if (empty || disabled) return;
    const draft: Draft = { text: text.trim(), image, audio };
    setText("");
    setImage(null);
    setAudio(null);
    await onSend(draft);
  };

  /**
   * Recording uses whatever container the browser gives us (webm/opus in
   * Chrome): the chat app stores the bytes as they are and the core converts
   * before transcribing, exactly as it does for a Telegram voice message.
   */
  const startRecording = async () => {
    setLocalError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        setAudio({ dataBase64: await blobToBase64(blob), mimeType: blob.type });
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } catch {
      setLocalError("The microphone is not available in this browser");
    }
  };

  const stopRecording = () => {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  };

  return (
    <>
      {error || localError ? <p className="text-xs text-danger">{error ?? localError}</p> : null}
      {audio ? (
        <Attachment
          icon={<Mic className="h-3.5 w-3.5" />}
          label="voice note ready to send"
          onRemove={() => setAudio(null)}
        />
      ) : null}
      {image ? (
        <Attachment
          icon={<ImagePlus className="h-3.5 w-3.5" />}
          label={image.name}
          onRemove={() => setImage(null)}
        />
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
                setLocalError("That file could not be read");
              }
            }}
          />
        </label>
        <Button
          variant={recording ? "danger" : "outline"}
          size="icon"
          onClick={() => (recording ? stopRecording() : void startRecording())}
          title={recording ? "Stop recording" : "Record a voice note"}
          aria-label={recording ? "Stop recording" : "Record a voice note"}
        >
          {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </Button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          maxLength={10_000}
          placeholder={placeholder}
          className="flex-1 resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
        />
        <Button onClick={() => void send()} disabled={disabled || empty}>
          <Send className="h-4 w-4" />
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </>
  );
}

/** One pending attachment, with the way to change your mind about it. */
function Attachment({
  icon,
  label,
  onRemove,
}: {
  icon: ReactNode;
  label: string;
  onRemove: () => void;
}) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted">
      {icon}
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        className="text-faint hover:text-foreground"
        aria-label={`Remove ${label}`}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </p>
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

/** A recorded blob as base64 (the payload the chat app stores). */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
