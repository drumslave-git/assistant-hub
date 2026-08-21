import { ArrowLeft, Database, Download } from "lucide-react";
import Link from "next/link";

import { getDb } from "@/db/drizzle";
import { Button, EmptyState, PageHeader, Tabs } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { getChatHistory } from "@/features/history/server/service";
import type { ChatMessageWithTrace } from "@/features/history/server/schema";
import {
  listChatSummaries,
  type ChatSummaryRecord,
} from "@/features/history/server/summaries-repository";
import { getMediaSuffixesForMessages } from "@/features/vision/server/service";
import { ChatHistoryTable } from "@/features/history/ui/ChatHistoryTable";
import { ChatSummariesList } from "@/features/history/ui/ChatSummariesList";

// History is read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Single-chat history mirror. Server Component: renders the full stored
 * conversation for one chat, including edit/delete flags.
 */
export default async function ChatHistoryPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const { chatId: raw } = await params;
  const chatId = decodeURIComponent(raw);

  let messages: ChatMessageWithTrace[] | null = null;
  let summaries: ChatSummaryRecord[] = [];
  let dbError: string | null = null;
  try {
    [messages, summaries] = await Promise.all([
      getChatHistory(chatId, {
        loadMediaSuffixes: (ids) => getMediaSuffixesForMessages(chatId, ids),
      }),
      listChatSummaries(getDb(), chatId),
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
              <a href={`/api/history/export?chatId=${encodeURIComponent(chatId)}`} download>
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
            description={`No stored history for chat ${chatId}.`}
          />
        ) : (
          <Tabs
            tabs={[
              {
                id: "messages",
                label: `Messages (${messages.length})`,
                content: <ChatHistoryTable chatId={chatId} messages={messages} />,
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
