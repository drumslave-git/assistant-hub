"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Sparkles } from "lucide-react";
import { buildInfo } from "@/lib/build-info";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Timestamp } from "@/components/time/Timestamp";
import { navGroupsForRole, type NavItem } from "./nav-config";

/**
 * What the shell's Bot status card shows: cheap configuration readiness plus
 * the poller's live state. Once everything is configured, the runtime state is
 * the part an operator actually watches — "Configured" alone says nothing about
 * whether the bot is up right now. Re-read on every `status` event (the bot
 * manager publishes each state change), so it stays live without a reload.
 */
export interface BotStatus {
  configured: boolean;
  detail: string;
  bot: {
    state: "stopped" | "running" | "error";
    username: string | null;
    /** ISO time the current run started, or null when not running. */
    since: string | null;
    /** Last error message when `state` is `error`, else null. */
    error: string | null;
  };
}

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const base =
    "group flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors";

  if (item.soon) {
    return (
      <span
        className={cn(base, "cursor-not-allowed text-faint")}
        title="Planned for v1"
      >
        <Icon className="h-4.5 w-4.5" />
        <span className="flex-1">{item.label}</span>
        <span className="text-[10px] font-medium tracking-wide text-faint uppercase">
          soon
        </span>
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        base,
        active
          ? "bg-primary-soft text-primary"
          : "text-muted hover:bg-surface-2 hover:text-foreground",
      )}
    >
      <Icon
        className={cn(
          "h-4.5 w-4.5",
          active ? "text-primary" : "text-faint group-hover:text-foreground",
        )}
      />
      <span className="flex-1">{item.label}</span>
    </Link>
  );
}

/** Dashboard sidebar contents. Reused by the fixed desktop rail and the mobile drawer. */
export function Sidebar({
  botStatus,
  role = "admin",
  onNavigate,
}: {
  botStatus: BotStatus;
  /** Filters the nav and the bot-status footer (Phase 8 roles). */
  role?: "admin" | "user";
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      {/* Brand / workspace header */}
      <div className="flex h-16 items-center gap-3 px-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Bot className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">llm-tg-bot</span>
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] leading-none text-faint">
              v{buildInfo.version}
            </span>
          </div>
          <div className="truncate text-xs text-faint">Control dashboard</div>
        </div>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
        {navGroupsForRole(role).map((group, i) => (
          <div key={group.label ?? i} className="space-y-0.5">
            {group.label ? (
              <div className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">
                {group.label}
              </div>
            ) : null}
            {group.items.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActive(pathname, item.href)}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}
      </nav>

      {/* Footer status card: the poller's live state once configured.
          Operator information - the user role does not see it. */}
      {role !== "admin" ? null : (
      <div className="p-3">
        <div className="rounded-xl border border-primary/30 bg-primary-soft p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            Bot status
          </div>
          <p className="mt-1 text-xs text-muted">
            {botStatus.bot.state === "running" ? (
              <>
                {/* A null username while running means several bots are up. */}
                {botStatus.bot.username ? `@${botStatus.bot.username}` : "Bots"} — polling
                {botStatus.bot.since ? (
                  <>
                    {" "}
                    since <Timestamp iso={botStatus.bot.since} />
                  </>
                ) : null}
              </>
            ) : botStatus.bot.state === "error" ? (
              (botStatus.bot.error ?? "Unknown error")
            ) : botStatus.configured ? (
              "The poller is stopped — start it from the Overview."
            ) : (
              botStatus.detail
            )}
          </p>
          <div className="mt-3 flex items-center justify-between">
            <Badge
              tone={
                botStatus.bot.state === "running"
                  ? "success"
                  : botStatus.bot.state === "error"
                    ? "danger"
                    : "warning"
              }
              dot
            >
              {botStatus.bot.state === "running"
                ? "Running"
                : botStatus.bot.state === "error"
                  ? "Error"
                  : botStatus.configured
                    ? "Stopped"
                    : "Setup needed"}
            </Badge>
            {botStatus.configured ? (
              <Button asChild size="sm" variant="primary">
                <Link href="/">Overview</Link>
              </Button>
            ) : (
              <Button asChild size="sm" variant="primary">
                <Link href="/settings">Configure</Link>
              </Button>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
