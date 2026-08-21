import { ArrowLeft, Database } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Button, EmptyState, PageHeader, Tabs } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { formatKnownGroupLabel } from "@/features/known-groups/format";
import { getGroupWithMembers } from "@/features/known-groups/server/service";
import type { GroupWithMembers } from "@/features/known-groups/server/schema";
import { GroupLanguageEditor } from "@/features/known-groups/ui/GroupLanguageEditor";
import { GroupMembersCard } from "@/features/known-groups/ui/GroupMembersCard";
import { GroupNotesEditor } from "@/features/known-groups/ui/GroupNotesEditor";

// Groups are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Single-group detail. Server Component: the group's notes editor and the roster
 * of its known members. `notFound()` for an unknown group id.
 */
export default async function GroupDetailPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const { chatId: raw } = await params;
  const chatId = decodeURIComponent(raw);

  let detail: GroupWithMembers | null = null;
  let dbError: string | null = null;
  try {
    detail = await getGroupWithMembers(chatId);
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read the group from the database";
  }

  if (!dbError && !detail) notFound();

  return (
    <>
      <PageHeader
        title={detail ? formatKnownGroupLabel(detail.group) : "Group"}
        description={detail ? `${detail.group.type ?? "group"} · ${chatId}` : chatId}
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="groups" />
            <Button asChild variant="outline" size="sm">
              <Link href="/groups">
                <ArrowLeft className="h-4 w-4" aria-hidden />
                All groups
              </Link>
            </Button>
          </div>
        }
      />

      {detail ? (
        <Tabs
          tabs={[
            {
              id: "settings",
              label: "Settings",
              content: (
                <div className="flex flex-col gap-6">
                  <GroupLanguageEditor group={detail.group} />
                  <GroupNotesEditor group={detail.group} />
                </div>
              ),
            },
            {
              id: "members",
              label: `Members (${detail.members.length})`,
              content: <GroupMembersCard members={detail.members} />,
            },
          ]}
        />
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The group could not be reached."}
        />
      )}
    </>
  );
}
