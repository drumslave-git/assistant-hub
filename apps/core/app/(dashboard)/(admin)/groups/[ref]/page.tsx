import { ArrowLeft, Database } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { isScopedRef } from "@assistant-hub-swarm/contracts";

import { Button, EmptyState, PageHeader, Tabs } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { formatKnownGroupLabel } from "@/features/known-groups/format";
import { GroupLanguageEditor } from "@/features/known-groups/ui/GroupLanguageEditor";
import { GroupMembersCard } from "@/features/known-groups/ui/GroupMembersCard";
import { GroupNotesEditor } from "@/features/known-groups/ui/GroupNotesEditor";
import {
  getDirectoryChat,
  listDirectoryChatMembers,
  type DirectoryChat,
  type DirectoryChatMember,
} from "@/server/source/directory";

// The chat is read from its source app at request time.
export const dynamic = "force-dynamic";

/**
 * Single-chat detail, addressed by scoped ref (`tg:chat:-100…`). Server
 * Component: the chat's curated fields and the roster of participants its
 * source knows, both read from the source that owns the conversation.
 * `notFound()` for a ref no source carries.
 */
export default async function GroupDetailPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref: raw } = await params;
  const chatRef = decodeURIComponent(raw);
  if (!isScopedRef(chatRef)) notFound();

  let chat: DirectoryChat | null = null;
  let members: DirectoryChatMember[] = [];
  let sourceError: string | null = null;
  try {
    chat = await getDirectoryChat(chatRef);
    if (chat) members = await listDirectoryChatMembers(chatRef);
  } catch (err) {
    sourceError = err instanceof Error ? err.message : "Could not read the chat from its source";
  }

  if (!sourceError && !chat) notFound();

  return (
    <>
      <PageHeader
        title={chat ? formatKnownGroupLabel({ title: chat.title, chatId: chat.id }) : "Group"}
        description={chat ? `${chat.sourceLabel} · ${chat.type ?? "group"} · ${chat.id}` : chatRef}
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

      {chat ? (
        <Tabs
          tabs={[
            {
              id: "settings",
              label: "Settings",
              content: (
                <div className="flex flex-col gap-6">
                  <GroupLanguageEditor group={chat} />
                  <GroupNotesEditor group={chat} />
                </div>
              ),
            },
            {
              id: "members",
              label: `Members (${members.length})`,
              content: <GroupMembersCard members={members} />,
            },
          ]}
        />
      ) : (
        <EmptyState
          icon={Database}
          title="Source unavailable"
          description={sourceError ?? "The chat could not be reached."}
        />
      )}
    </>
  );
}
