import { Bug } from "lucide-react";
import Link from "next/link";

import { Button, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { SourceUnavailableNotice } from "@/components/source/SourceUnavailableNotice";
import { featureDebugHref } from "@/lib/features";
import { listDirectoryChats } from "@/server/source/directory";
import { KnownGroupsList } from "@/features/known-groups/ui/KnownGroupsList";

// The directory is read from the source apps at request time.
export const dynamic = "force-dynamic";

/**
 * Known-groups directory. Server Component: aggregates every registered source
 * app's own chat listing through the shared operator contract and shows the
 * shared conversations (a direct chat's identity is its person, so those are
 * listed under Users). A source that could not be read is named above the
 * table rather than silently omitted.
 */
export default async function GroupsPage() {
  const { entries, unavailable } = await listDirectoryChats();
  const groups = entries.filter((chat) => chat.kind === "group");

  return (
    <>
      <PageHeader
        title="Known groups"
        description="Every shared conversation the bot takes part in, across every connected source. Members feed the participant roster injected into the model's context for that chat."
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

      <SourceUnavailableNotice sources={unavailable} />
      <KnownGroupsList groups={groups} />
    </>
  );
}
