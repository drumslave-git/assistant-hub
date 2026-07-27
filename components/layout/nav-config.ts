import {
  Activity,
  BarChart3,
  Brain,
  Bug,
  CalendarClock,
  Globe,
  GraduationCap,
  Image,
  LayoutDashboard,
  MessageSquare,
  Settings,
  Sparkles,
  Users,
  UsersRound,
  VenetianMask,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Planned-but-not-built routes render disabled with a "soon" hint. */
  soon?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/**
 * Single source of truth for dashboard navigation. Feature pages register here
 * as they land; `soon` marks planned v1 routes so the shell shows intended shape
 * without dead links.
 */
export const NAV_GROUPS: NavGroup[] = [
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
      { href: "/specialists", label: "Specialists", icon: GraduationCap },
      { href: "/memory", label: "Memory", icon: Brain },
      { href: "/tools", label: "Tools", icon: Wrench },
      { href: "/self-improvement", label: "Self-improvement", icon: Sparkles },
    ],
  },
  {
    // Work that runs without a message triggering it.
    label: "Automation",
    items: [
      { href: "/scheduled-tasks", label: "Scheduled tasks", icon: CalendarClock },
      { href: "/browser", label: "Browser agent", icon: Globe },
      { href: "/jobs", label: "Background jobs", icon: Activity },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/debug", label: "Debug", icon: Bug },
    ],
  },
];
