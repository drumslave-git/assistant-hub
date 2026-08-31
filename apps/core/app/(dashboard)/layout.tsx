import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/AppShell";
import { SystemAlerts } from "@/components/layout/SystemAlerts";
import { TimezoneProvider } from "@/components/time/TimezoneProvider";
import { getTimezone } from "@/features/settings/server/service";
import { SESSION_COOKIE } from "@/lib/auth";
import { judgeSessionToken } from "@/server/auth";
import { getConfigReadiness } from "@/server/status";
import { getSourceBotStatus } from "@/server/transports/status";

/**
 * The authenticated dashboard shell. This layout is the *real* page-side auth
 * gate (the proxy only does an optimistic cookie-presence redirect): it
 * verifies the session cookie's signature against the DB-stored secret before
 * rendering anything, sending bare visitors to `/login` and a fresh install to
 * `/setup`. Every dashboard page lives inside this route group; URLs are
 * unchanged.
 */
export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const verdict = await judgeSessionToken(token).catch(() => {
    // A DB outage must not lock the operator out of the status shell — the
    // pages themselves render their "database unavailable" states.
    return { kind: "db-down" } as const;
  });
  if (verdict.kind === "unconfigured") redirect("/setup");
  if (verdict.kind === "invalid") redirect("/login");
  // A temporary password holds the session at the change form (Phase 8).
  if (verdict.kind === "ok" && verdict.account.mustChangePassword) redirect("/password");
  // Unconfigured never reaches here and db-down renders the status shell —
  // both are the operator's situations, so the chrome falls back to admin.
  const shellAccount =
    verdict.kind === "ok"
      ? { displayName: verdict.account.displayName, role: verdict.account.role }
      : { displayName: "Operator", role: "admin" as const };

  const readiness = await getConfigReadiness();
  // The poller's live state (probed from the tg service, which owns it since
  // the source split) joins the config readiness so the shell's Bot status
  // card says what the bot is *doing*, not merely that it was once
  // configured. Re-read on every `status` event via the shell's live
  // refresh, so a crash or reconnect shows up without a reload.
  const { status: bot } = await getSourceBotStatus();
  // Every dashboard timestamp renders in this zone. Falls back to UTC when the
  // database is unreachable — the shell still renders its "database
  // unavailable" state rather than erroring on a formatting concern.
  const timezone = await getTimezone().catch(() => "UTC");

  return (
    <TimezoneProvider timezone={timezone}>
      <AppShell botStatus={{ ...readiness, bot }} account={shellAccount}>
        {/* Global data-loss alerts render above every page; see SystemAlerts. */}
        <SystemAlerts />
        {children}
      </AppShell>
    </TimezoneProvider>
  );
}
