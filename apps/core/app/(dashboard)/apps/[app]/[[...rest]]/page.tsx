import { Blocks } from "lucide-react";

import { findAppPage } from "@assistant-hub/ui";

import { EmptyState, PageHeader } from "@/components/ui";
import { APP_EXTENSIONS } from "@/components/layout/extensions";

/**
 * The shell's one mount point for app-contributed pages (PLAN.md, "Dashboard
 * composition"): everything under `/apps/<app>` belongs to that app's `ui`
 * subpackage, which routes within itself from the remaining segments. The
 * shell knows the extension point, never the apps — no route here names
 * "chat", and a second source app needs no change to this file.
 *
 * An unknown app renders a page that says so, rather than `notFound()`. The
 * two failures look identical from a browser otherwise — a route the dev
 * server has not compiled 404s exactly like a registry with no such app —
 * and telling them apart is the difference between "restart the dev server"
 * and "the app is not registered".
 */
export default async function AppExtensionPage({
  params,
}: {
  params: Promise<{ app: string; rest?: string[] }>;
}) {
  const { app, rest } = await params;
  const page = findAppPage(APP_EXTENSIONS, app);

  if (!page) {
    const mounted = APP_EXTENSIONS.filter((extension) => extension.page).map((e) => e.app);
    return (
      <div className="space-y-6">
        <PageHeader title="No app is mounted here" />
        <EmptyState
          icon={Blocks}
          title={`Nothing is registered as "${app}"`}
          description={
            mounted.length > 0
              ? `The apps with a page in this dashboard are: ${mounted.join(", ")}.`
              : "No app contributes a page to this dashboard yet."
          }
        />
      </div>
    );
  }

  const { Page } = page;
  return <Page segments={(rest ?? []).map((segment) => decodeURIComponent(segment))} />;
}
