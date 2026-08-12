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
import { featureDebugHref } from "@/lib/features";
import type { Backend } from "@/features/backends/server/schema";
import { getBackends, preloadBackendModels } from "@/features/backends/server/service";
import { getSettings } from "@/features/settings/server/service";
import type { Settings } from "@/features/settings/server/schema";
import { listUsers } from "@/features/known-users/server/service";
import type { KnownUser } from "@/features/known-users/server/schema";
import { SettingsForm } from "@/features/settings/ui/SettingsForm";

// Settings are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Settings dashboard page. Server Component: actually reads settings from the DB
 * for the initial render. If that read fails (DB unset/unreachable), it shows the
 * real error instead of a misleading "looks fine" — a genuine probe, not an
 * env-presence guess.
 */
export default async function SettingsPage() {
  let settings: Settings | null = null;
  let backends: Backend[] = [];
  let backendModels: Record<string, string[]> = {};
  let knownUsers: KnownUser[] = [];
  let dbError: string | null = null;
  try {
    settings = await getSettings();
    backends = await getBackends();
    // Preload every backend's model list so the role dropdowns are populated on
    // open; an unreachable backend yields an empty list and the form fetches
    // (and shows the error) when a role actually needs it.
    backendModels = await preloadBackendModels();
    // Known users populate the owner dropdown.
    knownUsers = await listUsers();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read settings from the database";
  }

  return (
    <>
      <PageHeader
        title="Settings"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={featureDebugHref("settings")}>
              <Bug className="h-4 w-4" aria-hidden />
              Debug
            </Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Bot configuration</CardTitle>
            <CardDescription>
              Stored in the database and used for every reply. Each role picks a backend from the
              shared catalog; changes are recorded as a trace.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {settings ? (
            <SettingsForm
              initial={settings}
              backends={backends}
              initialBackendModels={backendModels}
              knownUsers={knownUsers}
            />
          ) : (
            <EmptyState
              icon={Database}
              title="Database unavailable"
              description={dbError ?? "The settings database could not be reached."}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
