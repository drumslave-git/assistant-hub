import { notFound } from "next/navigation";

import { findAppPage } from "@assistant-hub/ui";

import { APP_EXTENSIONS } from "@/components/layout/extensions";

/**
 * The shell's one mount point for app-contributed pages (PLAN.md, "Dashboard
 * composition"): everything under `/apps/<app>` belongs to that app's `ui`
 * subpackage, which routes within itself from the remaining segments. The
 * shell knows the extension point, never the apps — no route here names
 * "chat", and a second source app needs no change to this file.
 */
export default async function AppExtensionPage({
  params,
}: {
  params: Promise<{ app: string; rest?: string[] }>;
}) {
  const { app, rest } = await params;
  const page = findAppPage(APP_EXTENSIONS, app);
  if (!page) notFound();
  const { Page } = page;
  return <Page segments={(rest ?? []).map((segment) => decodeURIComponent(segment))} />;
}
