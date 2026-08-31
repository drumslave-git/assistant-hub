import { Bug } from "lucide-react";
import Link from "next/link";

import { Button, PageHeader, Tabs } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { SourceUnavailableNotice } from "@/components/source/SourceUnavailableNotice";
import { featureDebugHref } from "@/lib/features";
import { listDirectoryUsers } from "@/server/source/directory";
import { KnownUsersTable } from "@/features/known-users/ui/KnownUsersTable";
import type { PersonLink } from "@/features/person-links/server/schema";
import { getPersonLinks } from "@/features/person-links/server/service";
import { PersonLinksManager } from "@/features/person-links/ui/PersonLinksManager";

// The directory is read from the source apps at request time.
export const dynamic = "force-dynamic";

/**
 * Known-users directory. Server Component: aggregates every registered source
 * app's own user listing through the shared operator contract, so a person is
 * shown by the source that owns them. A source that could not be read is
 * named above the tabs rather than silently omitted.
 *
 * The second tab is the same people seen as humans rather than as accounts:
 * the operator's person links, which memory reads resolve through.
 */
export default async function UsersPage() {
  const { entries, unavailable } = await listDirectoryUsers();

  let links: PersonLink[] = [];
  let linksError: string | null = null;
  try {
    links = await getPersonLinks();
  } catch (err) {
    linksError = err instanceof Error ? err.message : "Person links could not be read";
  }

  return (
    <>
      <PageHeader
        title="Known users"
        description="Everyone who has reached the bot, across every connected source. Curate aliases, and link identities to accounts so memory and owner rights follow the person."
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

      <Tabs
        tabs={[
          {
            id: "directory",
            label: "Directory",
            content: <KnownUsersTable users={entries} />,
          },
          {
            id: "people",
            label: `Linked people (${links.length})`,
            content: linksError ? (
              <p className="text-sm text-danger">{linksError}</p>
            ) : (
              <PersonLinksManager
                links={links}
                people={entries.map((entry) => ({
                  ref: entry.ref,
                  label: entry.label,
                  sourceLabel: entry.sourceLabel,
                }))}
              />
            ),
          },
        ]}
      />
    </>
  );
}
