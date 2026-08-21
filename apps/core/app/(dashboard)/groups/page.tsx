import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { featureDebugHref } from "@/lib/features";
import { listGroups } from "@/features/known-groups/server/service";
import type { KnownGroupSummary } from "@/features/known-groups/server/schema";
import { KnownGroupsList } from "@/features/known-groups/ui/KnownGroupsList";

// Groups are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Known-groups dashboard page. Server Component: lists every group the bot is
 * active in. Each row links to the group's detail (members + notes).
 */
export default async function GroupsPage() {
  let groups: KnownGroupSummary[] | null = null;
  let dbError: string | null = null;
  try {
    groups = await listGroups();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read groups from the database";
  }

  return (
    <>
      <PageHeader
        title="Known groups"
        description="Every group the bot is in. Members feed the participant roster injected into the model's context for that group."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="groups" />
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("known-groups")}>
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
          </div>
        }
      />

      {groups ? (
        <KnownGroupsList groups={groups} />
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The groups database could not be reached."}
        />
      )}
    </>
  );
}
