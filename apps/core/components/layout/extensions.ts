import type { AppExtensions } from "@assistant-hub/ui";
import { tgExtensions } from "@assistant-hub/tg-ui";

/**
 * The build-time extension registry (PLAN.md, "Dashboard composition"): the
 * one place the shell lists the source apps' `ui` subpackages. Adding a
 * source app means importing its `AppExtensions` export here — the shell
 * itself knows extension *points*, never the apps.
 *
 * tg registered with Phase 3 (the assistant editor's connection section);
 * chat joins in Phase 4.
 */
export const APP_EXTENSIONS: readonly AppExtensions[] = [tgExtensions];
