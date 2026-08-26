import { Bug } from "lucide-react";
import Link from "next/link";

import { Button, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { SourceUnavailableNotice } from "@/components/source/SourceUnavailableNotice";
import { featureDebugHref } from "@/lib/features";
import { listDirectoryUsers } from "@/server/source/directory";
import { KnownUsersTable } from "@/features/known-users/ui/KnownUsersTable";

// The directory is read from the source apps at request time.
export const dynamic = "force-dynamic";

/**
 * Known-users directory. Server Component: aggregates every registered source
 * app's own user listing through the shared operator contract, so a person is
 * shown by the source that owns them. A source that could not be read is
 * named above the table rather than silently omitted.
 */
export default async function UsersPage() {
  const { entries, unavailable } = await listDirectoryUsers();

  return (
    <>
      <PageHeader
        title="Known users"
        description="Everyone who has reached the bot, across every connected source. Curate aliases and pick the owner from this list in Settings."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="users" />
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("known-users")}>
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
          </div>
        }
      />

      <SourceUnavailableNotice sources={unavailable} />
      <KnownUsersTable users={entries} />
    </>
  );
}
