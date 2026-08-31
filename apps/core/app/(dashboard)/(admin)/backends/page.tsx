import { Bug, Database } from "lucide-react";
import Link from "next/link";

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
} from "@/components/ui";
import { getBackends, rolesUsingBackend } from "@/features/backends/server/service";
import type { Backend } from "@/features/backends/server/schema";
import { BackendsManager } from "@/features/backends/ui/BackendsManager";
import { featureDebugHref } from "@/lib/features";

// The catalog is read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Backends dashboard page. Server Component: reads the endpoint catalog from
 * the DB for the initial render; the manager mutates through the API and
 * refreshes. If the read fails (DB unset/unreachable), it shows the real error
 * instead of a misleading "looks fine".
 */
export default async function BackendsPage() {
  let backends: Backend[] | null = null;
  let inUse: Record<string, string[]> = {};
  let dbError: string | null = null;
  try {
    backends = await getBackends();
    const roleLists = await Promise.all(backends.map((b) => rolesUsingBackend(b.id)));
    inUse = Object.fromEntries(backends.map((b, i) => [b.id, roleLists[i]]));
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read backends from the database";
  }

  return (
    <>
      <PageHeader
        title="Backends"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={featureDebugHref("backends")}>
              <Bug className="h-4 w-4" aria-hidden />
              Debug
            </Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Endpoint catalog</CardTitle>
            <CardDescription>
              Every OpenAI-compatible server the bot can talk to. Settings roles (chat, embeddings,
              vision, …) pick from this list; changes are recorded as traces.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {backends ? (
            <BackendsManager backends={backends} inUse={inUse} />
          ) : (
            <EmptyState
              icon={Database}
              title="Database unavailable"
              description={dbError ?? "The backends database could not be reached."}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
