import { ArrowDownUp, Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { featureDebugHref } from "@/lib/features";
import { parseScopedRef } from "@assistant-hub-swarm/contracts";

import { actingAccount } from "@/server/auth/acting";
import { chatKey, servedChatKeys } from "@/server/ownership";
import { getHistoryOverview } from "@/features/history/server/service";
import type { ChatSummaryView } from "@/features/history/server/schema";
import {
  getSummaryJobInfo,
  type SummaryJobInfo,
} from "@/features/history/server/summary-scheduler";
import { ChatSummaryList } from "@/features/history/ui/ChatSummaryList";
import { SummaryJobCard } from "@/features/history/ui/SummaryJobCard";

// History is read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * History dashboard page. Server Component: lists the chats with stored history
 * and links to each chat's full mirror.
 */
export default async function HistoryPage() {
  // Role-scoped since Phase 9: a user sees the chats their own assistants
  // serve; the transfer/summary/debug chrome is the operator's.
  const account = await actingAccount();
  const restricted = account?.role === "user";

  let chats: ChatSummaryView[] | null = null;
  let summaryJob: SummaryJobInfo | null = null;
  let dbError: string | null = null;
  try {
    const [overview, jobInfo, served] = await Promise.all([
      getHistoryOverview(),
      getSummaryJobInfo(),
      servedChatKeys(account),
    ]);
    chats =
      served === null
        ? overview
        : overview.filter((chat) => {
            const { source, id } = parseScopedRef(chat.chatRef);
            return served.has(chatKey(source, id));
          });
    summaryJob = jobInfo;
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read history from the database";
  }

  return (
    <>
      <PageHeader
        title="History"
        description="The bot's stored conversations. Each reply injects the current day's messages as context."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="history" />
            {restricted ? null : (
              <>
                <Button asChild variant="outline" size="sm">
                  <Link href="/history/transfer">
                    <ArrowDownUp className="h-4 w-4" aria-hidden />
                    Import / export
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href={featureDebugHref("history-summaries")}>
                    <Bug className="h-4 w-4" aria-hidden />
                    Summary runs
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href={featureDebugHref("history")}>
                    <Bug className="h-4 w-4" aria-hidden />
                    Debug
                  </Link>
                </Button>
              </>
            )}
          </div>
        }
      />

      {chats ? (
        <div className="space-y-6">
          {summaryJob && !restricted ? <SummaryJobCard initial={summaryJob} /> : null}
          <ChatSummaryList chats={chats} />
        </div>
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
