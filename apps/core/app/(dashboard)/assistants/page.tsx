import { Bug, Database } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { featureDebugHref } from "@/lib/features";
import { listAccountViews } from "@/features/accounts/server/service";
import { getAssistants } from "@/features/assistants/server/service";
import { AssistantsManager } from "@/features/assistants/ui/AssistantsManager";
import { SESSION_COOKIE } from "@/lib/auth";
import { judgeSessionToken } from "@/server/auth";
import type { Assistant } from "@/features/assistants/server/schema";

// Assistants are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Assistants dashboard page. Server Component: lists the assistants and
 * delegates create/edit/delete to a Client Component. Each assistant's
 * transport connection is edited in its editor too, through the source apps'
 * extension sections (tg's bot connection first).
 */
export default async function AssistantsPage() {
  // Role-scoped since Phase 9: users see and manage their own assistants.
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const verdict = await judgeSessionToken(token).catch(() => ({ kind: "invalid" }) as const);
  const account = verdict.kind === "ok" ? verdict.account : null;
  const restricted = account?.role === "user";

  let assistants: Assistant[] | null = null;
  let dbError: string | null = null;
  let ownerNames: Record<string, string> | null = null;
  try {
    const all = await getAssistants();
    assistants = restricted ? all.filter((a) => a.ownerAccountId === account.id) : all;
    if (!restricted) {
      // Owner labels for the cards (admins see everyone's assistants).
      ownerNames = Object.fromEntries(
        (await listAccountViews()).map((a) => [a.id, a.displayName ?? a.username]),
      );
    }
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read assistants from the database";
  }

  return (
    <>
      <PageHeader
        title="Assistants"
        description="The bot's identities: each assistant has its own persona and its own bot connection; the assistant in a chat is implied by which bot is in it."
        actions={
          restricted ? null : (
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("assistants")}>
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
          )
        }
      />

      {assistants ? (
        <AssistantsManager assistants={assistants} ownerNames={ownerNames} />
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The assistants store could not be reached."}
        />
      )}
    </>
  );
}
