import type { ComponentType } from "react";

import type { LucideIcon } from "lucide-react";

/**
 * The typed extension points the dashboard shell composes from (PLAN.md,
 * "Dashboard composition"). Each source app ships a `ui` subpackage
 * (`apps/tg/ui`, `apps/chat/ui`, …) exporting one {@link AppExtensions};
 * the shell in `apps/core` lists them in its build-time registry — the one
 * sanctioned seam between apps. A `ui` subpackage may import shared packages
 * only: never its app's server code, never another app.
 */

/** One dashboard navigation link. */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Planned-but-not-built routes render disabled with a "soon" hint. */
  soon?: boolean;
}

/** A titled group of navigation links. No label on entry-point groups. */
export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/** Props the shell passes to a mounted assistant-editor section. */
export interface AssistantSectionProps {
  /** The assistant being edited. Sections mount only for existing assistants. */
  assistantId: string;
  /**
   * Increments when the shell hears the sources' state may have changed (a
   * poller flip, a connection edited elsewhere) — sections re-read their data
   * when it does, so they stay live without owning an event subscription.
   */
  refreshSignal: number;
}

/**
 * One section a source app contributes to the assistant editor (PLAN.md:
 * "entity-form sections" — tg's bot connection is the first). The component is
 * a Client Component; its data access goes through the owning app's operator
 * API behind the shell's proxy, never a direct import of server code.
 */
export interface AssistantSection {
  /** Stable id, unique across apps (the shell's React key), e.g. `"tg-connection"`. */
  id: string;
  /** Heading the shell renders above the section, for consistent editor chrome. */
  title: string;
  Section: ComponentType<AssistantSectionProps>;
}

/** Props the shell passes to a mounted app page. */
export interface AppPageProps {
  /**
   * Path segments below the app's mount point — `/apps/chat/<threadId>`
   * arrives as `["<threadId>"]`. The app routes within itself; the shell
   * knows only that an app owns everything under its mount.
   */
  segments: string[];
}

/**
 * The page an app mounts in the dashboard (PLAN.md: "routes/pages — chat
 * contributes the thread list and chat view"). One entry per app: the shell
 * renders it for the app's mount point and every path below it, so adding a
 * view is the app's business, not the shell's. A Client Component, like every
 * extension — its data goes through the owning app's operator API behind the
 * shell's proxy.
 */
export interface AppPage {
  Page: ComponentType<AppPageProps>;
}

/**
 * Everything one source app contributes to the dashboard shell.
 *
 * Navigation was the first typed extension point (Phase 0 skeleton);
 * assistant-editor sections landed with Phase 3. The remaining points from
 * PLAN.md — status cards, debug panels, aggregated entity views — get their
 * types here in the phases that introduce their first contributor.
 */
export interface AppExtensions {
  /** Unique source-app id, e.g. `"tg"`, `"chat"`. */
  app: string;
  /** Navigation groups this app adds to the sidebar. */
  navGroups?: NavGroup[];
  /** Sections this app adds to the assistant editor. */
  assistantSections?: AssistantSection[];
  /** The page this app mounts at `/apps/<app>` and everything below it. */
  page?: AppPage;
}

/** The mount path of an app's contributed page. */
export function appPageHref(app: string, ...segments: string[]): string {
  return ["/apps", app, ...segments.map(encodeURIComponent)].join("/");
}

/** The app whose page owns this mount, or undefined when none does. */
export function findAppPage(
  extensions: readonly AppExtensions[],
  app: string,
): AppPage | undefined {
  return extensions.find((e) => e.app === app)?.page;
}

/**
 * The shell's navigation: its own groups followed by each registered app's
 * contributions, in registry order.
 */
export function composeNavGroups(
  shellGroups: readonly NavGroup[],
  extensions: readonly AppExtensions[],
): NavGroup[] {
  return [...shellGroups, ...extensions.flatMap((e) => e.navGroups ?? [])];
}

/** Every registered app's assistant-editor sections, in registry order. */
export function composeAssistantSections(
  extensions: readonly AppExtensions[],
): AssistantSection[] {
  return extensions.flatMap((e) => e.assistantSections ?? []);
}
