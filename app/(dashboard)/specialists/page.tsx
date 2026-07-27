import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { Button, EmptyState, PageHeader } from "@/components/ui";
import { listGroups } from "@/features/known-groups/server/service";
import { listUsers } from "@/features/known-users/server/service";
import { formatKnownUserLabel } from "@/features/known-users/format";
import type { SpecialistEntry } from "@/features/specialists/server/schema";
import {
  getEntriesBrowserView,
  getSpecialistsView,
  type SpecialistsView,
} from "@/features/specialists/server/service";
import {
  SpecialistsManager,
  type AssignableChat,
} from "@/features/specialists/ui/SpecialistsManager";
import { featureDebugHref } from "@/lib/features";

// Specialists, assignments, and entries are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Specialists dashboard page. Server Component: loads the specialists, every
 * chat's activation, the assignable chats (known groups + DM chats), and the
 * latest stored entries, then delegates all interaction to a Client Component
 * that live-updates over the shared SSE stream.
 */
export default async function SpecialistsPage() {
  let view: SpecialistsView | null = null;
  let chats: AssignableChat[] = [];
  let entries: SpecialistEntry[] = [];
  let dbError: string | null = null;
  try {
    const [specialistsView, groups, users, entriesView] = await Promise.all([
      getSpecialistsView(),
      listGroups(),
      listUsers(),
      getEntriesBrowserView({}),
    ]);
    view = specialistsView;
    entries = entriesView.entries;
    // Assignable chats: every known group, and every known user's DM chat (a
    // private chat's id equals the user id).
    chats = [
      ...groups.map((g) => ({
        chatId: g.chatId,
        label: g.title ?? `Group ${g.chatId}`,
        kind: "group" as const,
      })),
      ...users.map((u) => ({
        chatId: u.userId,
        label: formatKnownUserLabel(u),
        kind: "dm" as const,
      })),
    ];
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read specialists from the database";
  }

  return (
    <>
      <PageHeader
        title="Specialists"
        description="Operator-authored bot roles with their own data. A chat's active specialist stacks onto the base prompt and personality."
        actions={
          <>
            <LiveIndicator topic="specialists" />
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("specialists")}>
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
          </>
        }
      />

      {view ? (
        <SpecialistsManager
          specialists={view.specialists}
          assignments={view.assignments}
          chats={chats}
          entries={entries}
        />
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The specialists database could not be reached."}
        />
      )}
    </>
  );
}
