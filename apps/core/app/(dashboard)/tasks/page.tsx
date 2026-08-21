import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { listGroups, listMemberships } from "@/features/known-groups/server/service";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { listUsers } from "@/features/known-users/server/service";
import {
  getTaskSchedulerInfo,
  type TaskSchedulerJobInfo,
} from "@/features/tasks/server/scheduler";
import { getTasksView } from "@/features/tasks/server/service";
import type { Task } from "@/features/tasks/types";
import {
  TasksManager,
  type TaskChat,
  type TaskChatMember,
} from "@/features/tasks/ui/TasksManager";
import { featureDebugHref } from "@/lib/features";

// Tasks and the chats they can live in are read at request time.
export const dynamic = "force-dynamic";

/**
 * Tasks dashboard page. Server Component: loads every task, the chats a task
 * can be scoped to (known groups + DM chats, with each group's roster for the
 * audience picker), and the poller status, then delegates interaction to a
 * Client Component that live-updates over the shared SSE stream.
 */
export default async function TasksPage() {
  let tasks: Task[] | null = null;
  let job: TaskSchedulerJobInfo | null = null;
  let chats: TaskChat[] = [];
  let authors: Record<string, string> = {};
  let dbError: string | null = null;
  try {
    const [view, groups, users, memberships, jobInfo] = await Promise.all([
      getTasksView(),
      listGroups(),
      listUsers(),
      listMemberships(),
      getTaskSchedulerInfo(),
    ]);
    tasks = view;
    job = jobInfo;
    // The people a group rule can be limited to: whoever has spoken there, in
    // the roster's order (most recently active first), labelled like everywhere.
    const labels = new Map(users.map((u) => [u.userId, formatKnownUserLabel(u)]));
    const membersByChat = new Map<string, TaskChatMember[]>();
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
    authors = Object.fromEntries(users.map((u) => [u.userId, formatKnownUserLabel(u)]));
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read tasks from the database";
  }

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Standing rules and timed jobs the bot carries out on its own. Set here, or by the people in a chat telling the bot."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="tasks" />
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("tasks")}>
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
          </div>
        }
      />

      {tasks && job ? (
        <TasksManager tasks={tasks} chats={chats} authors={authors} job={job} />
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The tasks database could not be reached."}
        />
      )}
    </>
  );
}
