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

/**
 * Everything one source app contributes to the dashboard shell.
 *
 * Navigation is the first typed extension point (Phase 0 skeleton). The
 * remaining points from PLAN.md — entity-form sections, status cards, debug
 * panels, aggregated entity views — get their types here in the phases that
 * introduce their first contributor.
 */
export interface AppExtensions {
  /** Unique source-app id, e.g. `"tg"`, `"chat"`. */
  app: string;
  /** Navigation groups this app adds to the sidebar. */
  navGroups?: NavGroup[];
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
