import {
  Activity,
  BarChart3,
  Bot,
  Brain,
  Bug,
  CalendarClock,
  Globe,
  Image,
  KeyRound,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  Server,
  Settings,
  Sparkles,
  Users,
  UsersRound,
  Wrench,
} from "lucide-react";

import type { LucideIcon } from "lucide-react";

/** One sidebar entry. */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Planned-but-not-built routes render disabled with a "soon" hint. */
  soon?: boolean;
}

/** One sidebar group (label optional for the landing group). */
export interface NavGroup {
  label?: string;
  items: NavItem[];
  /** Groups a user-role account never sees (Phase 8); default true. */
  adminOnly?: boolean;
}

/**
 * The shell's own navigation — the whole navigation since the extension
 * registry retired (Phase 7): the web chat is a core page (Phase 6) and
 * transport UI is schema-driven, so nothing composes into the shell at
 * build time any more.
 */
const SHELL_NAV_GROUPS: NavGroup[] = [
  {
    // Landing pages, no header: they are the entry point, not a category.
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
    ],
  },
  {
    // What the bot has seen and who it talked to.
    label: "Conversations",
    items: [
      { href: "/history", label: "History", icon: MessageSquare },
      { href: "/vision", label: "Vision", icon: Image },
      { href: "/users", label: "Users", icon: Users },
      { href: "/groups", label: "Groups", icon: UsersRound },
    ],
  },
  {
    // What shapes a reply: persona, durable knowledge, tools, learned corrections.
    label: "Bot",
    items: [
      { href: "/assistants", label: "Assistants", icon: Bot },
      { href: "/memory", label: "Memory", icon: Brain },
      { href: "/tools", label: "Tools", icon: Wrench },
      { href: "/self-improvement", label: "Self-improvement", icon: Sparkles },
    ],
  },
  {
    // Work the bot does on its own: standing rules, timed jobs, browsing.
    label: "Automation",
    items: [
      { href: "/tasks", label: "Tasks", icon: CalendarClock },
      { href: "/browser", label: "Browser agent", icon: Globe },
      { href: "/jobs", label: "Background jobs", icon: Activity },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/backends", label: "Backends", icon: Server },
      { href: "/accounts", label: "Accounts", icon: KeyRound },
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/debug", label: "Debug", icon: Bug },
    ],
  },
  {
    // The shell's own since the chat dissolve (Phase 6); kept in the spot
    // the chat app's extension used to render it. The one group every
    // account sees - the web chat is the user role's whole surface.
    label: "Web chat",
    adminOnly: false,
    items: [{ href: "/chat", label: "Chat", icon: MessagesSquare }],
  },
];

/** What the sidebar renders for a given account role. */
export function navGroupsForRole(role: "admin" | "user"): NavGroup[] {
  if (role === "admin") return SHELL_NAV_GROUPS;
  return SHELL_NAV_GROUPS.filter((group) => group.adminOnly === false);
}

/** What the sidebar renders (admin view; prefer {@link navGroupsForRole}). */
export const NAV_GROUPS: NavGroup[] = SHELL_NAV_GROUPS;
