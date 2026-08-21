import type { AppExtensions } from "@assistant-hub/ui";

/**
 * The build-time extension registry (PLAN.md, "Dashboard composition"): the
 * one place the shell lists the source apps' `ui` subpackages. Adding a
 * source app means importing its `AppExtensions` export here — the shell
 * itself knows extension *points*, never the apps.
 *
 * Empty until the source apps are carved out (tg in Phase 2, chat in
 * Phase 4).
 */
export const APP_EXTENSIONS: readonly AppExtensions[] = [];
