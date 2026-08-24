import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { featureDebugHref } from "@/lib/features";
import { getAssistants } from "@/features/assistants/server/service";
import { AssistantsManager } from "@/features/assistants/ui/AssistantsManager";
import type { Assistant } from "@/features/assistants/server/schema";

// Assistants are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Assistants dashboard page. Server Component: lists the assistants and
 * delegates create/edit/delete to a Client Component. Each assistant's
 * transport connection is edited here too once the source apps' extension
 * sections land (Phase 3, connections slice).
 */
export default async function AssistantsPage() {
  let assistants: Assistant[] | null = null;
  let dbError: string | null = null;
  try {
    assistants = await getAssistants();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read assistants from the database";
  }

  return (
    <>
      <PageHeader
        title="Assistants"
        description="The bot's identities: each assistant has its own persona and its own bot connection; the assistant in a chat is implied by which bot is in it."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={featureDebugHref("assistants")}>
              <Bug className="h-4 w-4" aria-hidden />
              Debug
            </Link>
          </Button>
        }
      />

      {assistants ? (
        <AssistantsManager assistants={assistants} />
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
