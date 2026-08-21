import { ArrowLeft, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { getHistoryOverview } from "@/features/history/server/service";
import type { ChatSummaryView } from "@/features/history/server/schema";
import { HistoryTransferPanel } from "@/features/history/ui/HistoryTransferPanel";

// The chat list backing the export scope is read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * History CSV transfer page. Server Component: loads the chat list for the
 * export scope picker and hands the interactive import/export panel to the
 * client.
 */
export default async function HistoryTransferPage() {
  let chats: ChatSummaryView[] | null = null;
  let dbError: string | null = null;
  try {
    chats = await getHistoryOverview();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read history from the database";
  }

  return (
    <>
      <PageHeader
        title="Import / export"
        description="Move the conversation mirror in and out as CSV. Imports skip messages that are already stored."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/history">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              History
            </Link>
          </Button>
        }
      />

      {chats ? (
        <HistoryTransferPanel chats={chats} />
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
