import { ArrowLeft, Database, Download } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { tryParseScopedRef } from "@assistant-hub-swarm/contracts";

import { Button, EmptyState, PageHeader, Tabs } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { getChatHistory } from "@/features/history/server/service";
import type { ChatMessageWithTrace } from "@/features/history/server/schema";
import type { ChatSummaryRecord } from "@/features/history/server/summaries-repository";
import { actingAccount } from "@/server/auth/acting";
import { chatKey, servedChatKeys } from "@/server/ownership";
import { requireSourceContent } from "@/server/source/content";
import { ChatHistoryTable } from "@/features/history/ui/ChatHistoryTable";
import { ChatSummariesList } from "@/features/history/ui/ChatSummariesList";

// History is read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Single-chat history mirror, addressed by the chat's scoped ref
 * (`tg:chat:-100…`). Server Component: renders the full stored conversation
 * for one chat, including edit/delete flags.
 */
export default async function ChatHistoryPage({
  params,
}: {
  params: Promise<{ ref: string }>;
}) {
  const { ref: raw } = await params;
  const chatRef = decodeURIComponent(raw);
  const parsed = tryParseScopedRef(chatRef);
  if (parsed?.kind !== "chat") notFound();

  // Phase 9: a user opens only chats their own assistants serve.
  const served = await servedChatKeys(await actingAccount()).catch(() => null);
  if (served !== null && !served.has(chatKey(parsed.source, parsed.id))) notFound();

  let messages: ChatMessageWithTrace[] | null = null;
  let summaries: ChatSummaryRecord[] = [];
  let dbError: string | null = null;
  try {
    [messages, summaries] = await Promise.all([
      getChatHistory(chatRef),
      requireSourceContent().listSummaries(chatRef),
    ]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read history from the database";
  }

  return (
    <>
      <PageHeader
        title="Conversation"
        description="Full stored mirror for this chat, newest first."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="history" />
            <Button asChild variant="outline" size="sm">
              <a href={`/api/history/export?chatRef=${encodeURIComponent(chatRef)}`} download>
                <Download className="h-4 w-4" aria-hidden />
                Export CSV
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/history">
                <ArrowLeft className="h-4 w-4" aria-hidden />
                All chats
              </Link>
            </Button>
          </div>
        }
      />

      {messages ? (
        messages.length === 0 ? (
          <EmptyState
            icon={Database}
            title="No messages"
            description={`No stored history for chat ${chatRef}.`}
          />
        ) : (
          <Tabs
            tabs={[
              {
                id: "messages",
                label: `Messages (${messages.length})`,
                content: <ChatHistoryTable chatRef={chatRef} messages={messages} />,
              },
              {
                id: "summaries",
                label: `Summaries (${summaries.length})`,
                content: <ChatSummariesList summaries={summaries} />,
              },
            ]}
          />
        )
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The history database could not be reached."}
        />
      )}
    </>
  );
}
