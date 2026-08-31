import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { getMemoryJobInfo, type MemoryJobInfo } from "@/features/memory/server/scheduler";
import { getMemoryView, type MemoryView } from "@/features/memory/server/service";
import { MemoryJobCard } from "@/features/memory/ui/MemoryJobCard";
import { MemoryPanel } from "@/features/memory/ui/MemoryPanel";
import { featureDebugHref } from "@/lib/features";

// Memory is read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Memory dashboard page. Server Component: shows the pending queue, what the bot
 * durably knows about each person, the shared general knowledge, and the status of
 * the nightly consolidation job.
 */
export default async function MemoryPage() {
  let view: MemoryView | null = null;
  let job: MemoryJobInfo | null = null;
  let dbError: string | null = null;
  try {
    [view, job] = await Promise.all([getMemoryView(), getMemoryJobInfo()]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read memory from the database";
  }

  return (
    <>
      <PageHeader
        title="Memory"
        description="What the bot durably knows — a document per person, injected into the conversations they take part in, and one document of shared general knowledge, injected into every reply."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="memory" />
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("memory")}>
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("mcp-tools-memory")}>
                <Bug className="h-4 w-4" aria-hidden />
                Tool calls
              </Link>
            </Button>
          </div>
        }
      />

      {view && job ? (
        <div className="space-y-6">
          <MemoryJobCard initial={job} />
          <MemoryPanel view={view} />
        </div>
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The memory database could not be reached."}
        />
      )}
    </>
  );
}
