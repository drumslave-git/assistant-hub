import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { featureDebugHref } from "@/lib/features";
import {
  getPersonalitiesView,
  type PersonalitiesView,
} from "@/features/personalities/server/service";
import { PersonalitiesManager } from "@/features/personalities/ui/PersonalitiesManager";

// Personalities are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Personalities dashboard page. Server Component: lists the personas, marks the
 * active one, and delegates create/edit/delete/set-active to a Client Component.
 */
export default async function PersonalitiesPage() {
  let view: PersonalitiesView | null = null;
  let dbError: string | null = null;
  try {
    view = await getPersonalitiesView();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read personalities from the database";
  }

  return (
    <>
      <PageHeader
        title="Personalities"
        description="Named personas for the bot. The active one is composed into the base system prompt on every reply."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={featureDebugHref("personalities")}>
              <Bug className="h-4 w-4" aria-hidden />
              Debug
            </Link>
          </Button>
        }
      />

      {view ? (
        <PersonalitiesManager personalities={view.personalities} activeId={view.activeId} />
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The personalities database could not be reached."}
        />
      )}
    </>
  );
}
