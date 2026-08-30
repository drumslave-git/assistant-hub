import type { AppExtensions } from "@assistant-hub/ui";
import { tgExtensions } from "@assistant-hub/tg-ui";

/**
 * The build-time extension registry (PLAN.md's original "Dashboard
 * composition"): the one place the shell lists the source apps' `ui`
 * subpackages. tg registered with Phase 3 (the assistant editor's connection
 * section); chat joined in Phase 4 and left with the Phase 6 dissolve (its
 * page is the shell's own `/chat` route now). The revised target retires
 * this mechanism for schema-driven transport config forms (Phase 7).
 */
export const APP_EXTENSIONS: readonly AppExtensions[] = [tgExtensions];
