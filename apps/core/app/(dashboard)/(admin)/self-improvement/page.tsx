import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { featureDebugHref } from "@/lib/features";
import {
  getSelfImprovementJobInfo,
  type SelfImprovementJobInfo,
} from "@/features/self-improvement/server/scheduler";
import {
  getSelfImprovementView,
  type SelfImprovementView,
} from "@/features/self-improvement/server/service";
import { SelfImprovementJobCard } from "@/features/self-improvement/ui/SelfImprovementJobCard";
import { SelfImprovementPanel } from "@/features/self-improvement/ui/SelfImprovementPanel";

// Feedback data is read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Self-improvement dashboard page. Server Component: shows the collected 👍/👎
 * feedback, the learned per-user communication preferences and global
 * self-corrections, and the daily incorporation job's status.
 */
export default async function SelfImprovementPage() {
  let view: SelfImprovementView | null = null;
  let job: SelfImprovementJobInfo | null = null;
  let dbError: string | null = null;
  try {
    [view, job] = await Promise.all([getSelfImprovementView(), getSelfImprovementJobInfo()]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read feedback from the database";
  }

  return (
    <>
      <PageHeader
        title="Self-improvement"
        description="User feedback on the bot's replies, and what it has learned from it — per-user communication preferences and global self-corrections."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="feedback" />
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("user-feedback")}>
                <Bug className="h-4 w-4" aria-hidden />
                Feedback debug
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("self-improvement")}>
                <Bug className="h-4 w-4" aria-hidden />
                Job debug
              </Link>
            </Button>
          </div>
        }
      />

      {view && job ? (
        <div className="space-y-6">
          <SelfImprovementJobCard initial={job} />
          <SelfImprovementPanel view={view} />
        </div>
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The feedback database could not be reached."}
        />
      )}
    </>
  );
}
