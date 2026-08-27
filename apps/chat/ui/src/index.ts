import { MessagesSquare } from "lucide-react";

import { appPageHref, type AppExtensions } from "@assistant-hub/ui";

import { ChatThreadsPage } from "./ThreadsPage";

/**
 * What the chat app contributes to the dashboard shell (PLAN.md, "Dashboard
 * composition"): a nav entry and the page it leads to. The shell mounts the
 * page at this app's mount point and everything below it, so new views (a
 * thread's conversation) are added here, not in the shell.
 */
export const chatExtensions: AppExtensions = {
  app: "chat",
  navGroups: [
    {
      label: "Web chat",
      items: [
        { href: appPageHref("chat"), label: "Chat", icon: MessagesSquare },
      ],
    },
  ],
  page: { Page: ChatThreadsPage },
};
