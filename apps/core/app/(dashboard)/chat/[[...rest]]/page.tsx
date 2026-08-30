import { ChatThreadsPage } from "@/components/chat/ThreadsPage";

/**
 * The web chat, a plain core route since the chat dissolve (Phase 6) — the
 * page routes within itself from the remaining segments (`/chat` is the
 * thread list with a blank conversation, `/chat/<id>` one thread).
 */
export default async function ChatPage({
  params,
}: {
  params: Promise<{ rest?: string[] }>;
}) {
  const { rest } = await params;
  return <ChatThreadsPage segments={(rest ?? []).map((segment) => decodeURIComponent(segment))} />;
}
