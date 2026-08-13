import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { Button, EmptyState, PageHeader } from "@/components/ui";
import type { ChatRule } from "@/features/chat-rules/server/schema";
import { getChatRulesView } from "@/features/chat-rules/server/service";
import { ChatRulesManager, type RuleChat } from "@/features/chat-rules/ui/ChatRulesManager";
import { listGroups, listMemberships } from "@/features/known-groups/server/service";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { listUsers } from "@/features/known-users/server/service";
import { featureDebugHref } from "@/lib/features";

// Rules and the chats they can be scoped to are read at request time.
export const dynamic = "force-dynamic";

/**
 * Chat rules dashboard page. Server Component: loads every rule and the chats a
 * rule can be scoped to (known groups + DM chats), then delegates interaction to
 * a Client Component that live-updates over the shared SSE stream.
 */
export default async function ChatRulesPage() {
  let rules: ChatRule[] | null = null;
  let chats: RuleChat[] = [];
  let dbError: string | null = null;
  try {
    const [view, groups, users, memberships] = await Promise.all([
      getChatRulesView(),
      listGroups(),
      listUsers(),
      listMemberships(),
    ]);
    rules = view;
    // The people a group rule can be limited to: whoever has spoken there, in the
    // roster's order (most recently active first), labelled like everywhere else.
    const labels = new Map(users.map((u) => [u.userId, formatKnownUserLabel(u)]));
    const membersByChat = new Map<string, { userId: string; label: string }[]>();
    for (const { chatId, userId } of memberships) {
      const label = labels.get(userId);
      if (!label) continue;
      membersByChat.set(chatId, [...(membersByChat.get(chatId) ?? []), { userId, label }]);
    }
    // A private chat's id equals the user id, so a DM is addressable by user.
    chats = [
      ...groups.map((g) => ({
        chatId: g.chatId,
        label: g.title ?? `Group ${g.chatId}`,
        kind: "group" as const,
        members: membersByChat.get(g.chatId) ?? [],
      })),
      ...users.map((u) => ({
        chatId: u.userId,
        label: formatKnownUserLabel(u),
        kind: "dm" as const,
        members: [],
      })),
    ];
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read chat rules from the database";
  }

  return (
    <>
      <PageHeader
        title="Chat rules"
        description="Standing instructions the bot follows in a chat. Set here, or by the people in the chat telling the bot a new rule."
        actions={
          <>
            <LiveIndicator topic="rules" />
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("chat-rules")}>
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
          </>
        }
      />

      {rules ? (
        <ChatRulesManager rules={rules} chats={chats} />
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The chat-rules database could not be reached."}
        />
      )}
    </>
  );
}
