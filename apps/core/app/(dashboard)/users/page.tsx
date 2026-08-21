import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { featureDebugHref } from "@/lib/features";
import { listUsers } from "@/features/known-users/server/service";
import type { KnownUser } from "@/features/known-users/server/schema";
import { KnownUsersTable } from "@/features/known-users/ui/KnownUsersTable";

// Users are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Known-users dashboard page. Server Component: lists every user who has messaged
 * the bot. The table (a Client Component) owns its own card + inline alias edits.
 */
export default async function UsersPage() {
  let users: KnownUser[] | null = null;
  let dbError: string | null = null;
  try {
    users = await listUsers();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read users from the database";
  }

  return (
    <>
      <PageHeader
        title="Known users"
        description="Everyone who has messaged the bot. Curate aliases and pick the owner from this list in Settings."
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

      {users ? (
        <KnownUsersTable users={users} />
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The users database could not be reached."}
        />
      )}
    </>
  );
}
