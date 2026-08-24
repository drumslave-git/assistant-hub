import type { AppExtensions } from "@assistant-hub/ui";

import { TgConnectionSection } from "./ConnectionSection";

/**
 * What the tg app contributes to the dashboard shell (PLAN.md, "Dashboard
 * composition"): the assistant editor's Telegram connection section. No nav
 * groups — the shell's own pages already cover this app's entities.
 */
export const tgExtensions: AppExtensions = {
  app: "tg",
  assistantSections: [
    {
      id: "tg-connection",
      title: "Telegram connection",
      Section: TgConnectionSection,
    },
  ],
};
