import { composeNavGroups, type NavGroup } from "@assistant-hub/ui";
import {
  Activity,
  BarChart3,
  Brain,
  Bug,
  CalendarClock,
  Globe,
  Image,
  LayoutDashboard,
  MessageSquare,
  Server,
  Settings,
  Sparkles,
  Users,
  UsersRound,
  VenetianMask,
  Wrench,
} from "lucide-react";

import { APP_EXTENSIONS } from "./extensions";

export type { NavGroup, NavItem } from "@assistant-hub/ui";

/**
 * The shell's own navigation. Feature pages register here as they land; `soon`
 * marks planned v1 routes so the shell shows intended shape without dead links.
 * Source apps contribute their groups through the extension registry, composed
 * into {@link NAV_GROUPS} below.
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
      { href: "/personalities", label: "Personalities", icon: VenetianMask },
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
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/debug", label: "Debug", icon: Bug },
    ],
  },
];

/**
 * What the sidebar renders: the shell's groups plus every registered source
 * app's contributions (none yet — the registry is empty until Phase 2).
 */
export const NAV_GROUPS: NavGroup[] = composeNavGroups(
  SHELL_NAV_GROUPS,
  APP_EXTENSIONS,
);
