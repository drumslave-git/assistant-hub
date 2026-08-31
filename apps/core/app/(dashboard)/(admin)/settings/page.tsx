import { Bug, Database } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Skeleton,
} from "@/components/ui";
import { featureDebugHref } from "@/lib/features";
import { getBackends, preloadBackendModels } from "@/features/backends/server/service";
import { getSettings } from "@/features/settings/server/service";
import { listUsers } from "@/features/known-users/server/service";
import { SettingsForm } from "@/features/settings/ui/SettingsForm";

// Settings are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Settings dashboard page. Server Component: actually reads settings from the DB
 * for the initial render. If that read fails (DB unset/unreachable), it shows the
 * real error instead of a misleading "looks fine" — a genuine probe, not an
 * env-presence guess.
 *
 * The shell paints immediately and the form streams in: its reads include a
 * model-list probe of every stored backend, and one dead endpoint used to hold
 * the whole page white for its timeout (operator report, 2026-08-15).
 */
export default function SettingsPage() {
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
          <Suspense fallback={<Skeleton className="h-96" />}>
            <SettingsFormLoader />
          </Suspense>
        </CardContent>
      </Card>
    </>
  );
}

/** The form's reads, streamed — independent of each other, so they run together. */
async function SettingsFormLoader() {
  let data: Awaited<ReturnType<typeof loadSettingsFormData>> | null = null;
  let dbError: string | null = null;
  try {
    data = await loadSettingsFormData();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read settings from the database";
  }

  if (!data) {
    return (
      <EmptyState
        icon={Database}
        title="Database unavailable"
        description={dbError ?? "The settings database could not be reached."}
      />
    );
  }
  return (
    <SettingsForm
      initial={data.settings}
      backends={data.backends}
      initialBackendModels={data.backendModels}
      knownUsers={data.knownUsers}
    />
  );
}

/**
 * Settings + catalog + model preload + known users — independent reads run
 * together; the sequential awaits this replaces made every page load their sum.
 */
async function loadSettingsFormData() {
  const [settings, backends, backendModels, knownUsers] = await Promise.all([
    getSettings(),
    getBackends(),
    // Preload every backend's model list so the role dropdowns are populated on
    // open; an unreachable backend yields an empty list and the form fetches
    // (and shows the error) when a role actually needs it.
    preloadBackendModels(),
    // Known users populate the owner dropdown.
    listUsers(),
  ]);
  return { settings, backends, backendModels, knownUsers };
}
