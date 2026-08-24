import {
  AlertTriangle,
  BarChart3,
  Bug,
  CheckCircle2,
  Coins,
  MessageSquare,
  Settings as SettingsIcon,
  Users,
} from "lucide-react";
import Link from "next/link";
import { cache, Suspense } from "react";

import { TraceList } from "@/components/debug";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { Timestamp } from "@/components/time/Timestamp";
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Skeleton,
  StatCard,
  StatusCard,
  Tabs,
  type StatusTone,
  type TabItem,
} from "@/components/ui";
import type { OperatorConnection } from "@assistant-hub/contracts";

import { getAssistants } from "@/features/assistants/server/service";
import { BotControl } from "@/features/bot-messaging/ui/BotControl";
import { getAllJobs } from "@/features/jobs/server/registry";
import { JobHealthList } from "@/features/jobs/ui/JobHealthList";
import { buildInfo } from "@/lib/build-info";
import type { RealtimeTopic } from "@/lib/realtime";
import { getOverviewActivity, OVERVIEW_WINDOW_HOURS } from "@/server/overview";
import { getSystemStatus, type EndpointStatus } from "@/server/status";
import { listSourceConnections, summarizeConnections } from "@/server/source/tg-operator";

// Probe real state at request time (DB query + LLM endpoint call + trace reads),
// so the overview reflects what actually works, not build-time or env-presence
// guesses.
export const dynamic = "force-dynamic";

// One activity read per render pass, shared by the stat row and the tabs.
const readActivity = cache(() => getOverviewActivity());

interface StatusItem {
  label: string;
  tone: StatusTone;
  value: string;
  hint: string;
}

/**
 * One labelled block of the status grid. Thirteen equally-weighted tiles in a
 * flat grid gave "the database is down" and "images are switched off" the same
 * visual weight; grouping separates the things that must be true for the bot to
 * work at all from the optional roles and the write paths.
 */
interface StatusGroup {
  title: string;
  description: string;
  items: StatusItem[];
}

/**
 * How each optional-endpoint state reads on its card. Neither "Off" (a
 * deliberate choice) nor "Chat model" (the role running on the main model, per
 * "main by default") is a fault, so both render neutral — but only one of them
 * means the capability is unavailable, and the card must not confuse the two.
 * A configured endpoint that fails its probe is the actual error.
 */
const ENDPOINT_PRESENTATION: Record<
  EndpointStatus["state"],
  { tone: StatusTone; value: string }
> = {
  ok: { tone: "ok", value: "Connected" },
  inherited: { tone: "neutral", value: "Chat model" },
  off: { tone: "neutral", value: "Off" },
  error: { tone: "error", value: "Error" },
};

/**
 * What the page live-updates on. Deliberately not every job topic: `traces`
 * already fires for the work those jobs do, and this render is expensive (live
 * LLM probes plus a trace scan), so a wider subscription would buy nothing and
 * cost a full re-probe per event.
 */
const OVERVIEW_TOPICS: RealtimeTopic[] = ["traces", "status", "bot"];

const number = (value: number): string => value.toLocaleString("en-US");

/** Tokens read at a glance: 1.2M / 43.1k / 812. */
function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** "3 problems" / "1 needs setup" / "all clear" for a group's heading. */
function groupSummary(items: StatusItem[]): { text: string; tone: "error" | "warn" | "ok" } {
  const errors = items.filter((item) => item.tone === "error").length;
  const warns = items.filter((item) => item.tone === "warn").length;
  if (errors > 0) return { text: `${errors} failing`, tone: "error" };
  if (warns > 0) return { text: `${warns} needs setup`, tone: "warn" };
  return { text: "All clear", tone: "ok" };
}

/**
 * Dashboard overview. Server Component: reads live {@link getSystemStatus} — a
 * real `SELECT 1` and a real `/v1/models` probe — plus what the bot has actually
 * been doing ({@link getOverviewActivity}) and whether every background job is
 * still running, so operators see honest state rather than configuration alone.
 *
 * Streamed in sections: the shell paints immediately and each section arrives
 * as its own reads finish, so a slow LLM probe delays the status card — never
 * the whole page (operator report, 2026-08-15: Overview load too long).
 */
export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        description={`llm-tg-bot dashboard — v${buildInfo.version}`}
        actions={
          <>
            {/* One subscription for the whole page. Every block here re-reads on
                the same `router.refresh()`, so a second indicator would only add
                a duplicate refresh of an already expensive render. */}
            <LiveIndicator topic={OVERVIEW_TOPICS} />
            <Button asChild variant="outline" leftIcon={<SettingsIcon className="h-4 w-4" />}>
              <Link href="/settings">Settings</Link>
            </Button>
          </>
        }
      />

      <Suspense fallback={<StatRowSkeleton />}>
        <ActivityStatsSection />
      </Suspense>

      <Suspense fallback={<SectionSkeleton title="System status" />}>
        <SystemStatusSection />
      </Suspense>

      <Suspense fallback={<SectionSkeleton title="Activity" />}>
        <ActivityTabsSection />
      </Suspense>
    </>
  );
}

/** Shimmer for the 24h stat row while the trace scan runs. */
function StatRowSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-24" />
      ))}
    </div>
  );
}

/** Shimmer card standing in for a streamed section. */
function SectionSkeleton({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-40" />
      </CardContent>
    </Card>
  );
}

/** The last-24h stat row — the trace-scan read. */
async function ActivityStatsSection() {
  const activity = await readActivity();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">
            Last {OVERVIEW_WINDOW_HOURS} hours
          </h2>
          <p className="text-sm text-muted">
            What the bot actually did, since <Timestamp iso={activity.since} />.
          </p>
        </div>
        <Button asChild variant="outline" size="sm" leftIcon={<BarChart3 className="h-4 w-4" />}>
          <Link href="/analytics">Analytics</Link>
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Messages handled"
          value={number(activity.handled)}
          icon={MessageSquare}
          accent
          hint={`${number(activity.replied)} answered`}
        />
        <StatCard
          label="Failures"
          value={number(activity.failed)}
          icon={AlertTriangle}
          hint={
            activity.failed > 0 ? (
              <Link href="/debug?status=error" className="text-primary hover:underline">
                Inspect in Debug
              </Link>
            ) : (
              "No failed replies"
            )
          }
        />
        <StatCard
          label="Active people"
          value={number(activity.activeUsers)}
          icon={Users}
          hint={`${number(activity.images)} media described`}
        />
        <StatCard
          label="Tokens"
          value={compactTokens(activity.promptTokens + activity.completionTokens)}
          icon={Coins}
          hint={`${compactTokens(activity.promptTokens)} in · ${compactTokens(activity.completionTokens)} out`}
        />
      </div>
    </div>
  );
}

/** The live-probe status card — the slow section, streamed on its own. */
async function SystemStatusSection() {
  const [connectionsResult, assistants, status] = await Promise.all([
    // Connections are per assistant since Phase 3; every status surface here
    // summarizes across all of them.
    listSourceConnections().then(
      (connections) => ({ connections, error: null as string | null }),
      (err: unknown) => ({
        connections: [] as OperatorConnection[],
        error: err instanceof Error ? err.message : String(err),
      }),
    ),
    getAssistants().catch(() => []),
    getSystemStatus(),
  ]);
  const { status: botStatus, configured: telegramConfigured } = connectionsResult.error
    ? {
        status: {
          state: "error" as const,
          username: null,
          since: null,
          error: connectionsResult.error,
        },
        configured: false,
      }
    : summarizeConnections(connectionsResult.connections);

  const botItem: StatusItem =
    botStatus.state === "running"
      ? {
          label: "Telegram bots",
          tone: "ok",
          value: "Running",
          hint: botStatus.username ? `@${botStatus.username} — long polling` : "long polling",
        }
      : botStatus.state === "error"
        ? { label: "Telegram bots", tone: "error", value: "Error", hint: botStatus.error ?? "unknown error" }
        : telegramConfigured
          ? { label: "Telegram bots", tone: "warn", value: "Stopped", hint: "Ready — start below" }
          : {
              label: "Telegram bots",
              tone: "warn",
              value: "Not configured",
              hint: "Connect a bot to an assistant",
            };

  const llmItem: StatusItem =
    status.llm.state === "connected"
      ? {
          label: "LLM endpoint",
          tone: "ok",
          value: "Connected",
          hint: `${status.llm.modelCount ?? 0} models available`,
        }
      : status.llm.state === "error"
        ? { label: "LLM endpoint", tone: "error", value: "Unreachable", hint: status.llm.detail }
        : { label: "LLM endpoint", tone: "warn", value: "Not configured", hint: status.llm.detail };

  const tracesItem: StatusItem = status.traces.ok
    ? { label: "Trace storage", tone: "ok", value: "Writable", hint: status.traces.detail }
    : {
        label: "Trace storage",
        tone: "error",
        value: "Not writable",
        hint: `${status.traces.detail} — ${status.traces.pendingCount} unflushed trace(s) buffered in memory`,
      };

  // A failed download reports itself on the run that attempted one, so this is a
  // warning rather than an error — but it is probed here so the operator learns
  // about an unwritable mount before a user's request is the thing that finds it.
  const downloadsItem: StatusItem = status.downloads.ok
    ? { label: "Downloads", tone: "ok", value: "Writable", hint: status.downloads.detail }
    : {
        label: "Downloads",
        tone: "warn",
        value: "Not writable",
        hint: `${status.downloads.detail} — browser-agent downloads will fail`,
      };

  // The optional endpoints, one card each.
  const endpointItems: StatusItem[] = status.endpoints.map((endpoint) => ({
    label: endpoint.label,
    ...ENDPOINT_PRESENTATION[endpoint.state],
    hint: endpoint.detail,
  }));

  const groups: StatusGroup[] = [
    {
      title: "Core",
      description: "Nothing works without these",
      items: [
        {
          label: "Database",
          tone: status.db.connected ? "ok" : "error",
          value: status.db.connected ? "Connected" : "Unavailable",
          hint: status.db.detail,
        },
        llmItem,
        {
          label: "Model",
          tone: status.model.selected ? "ok" : "warn",
          value: status.model.selected ? "Selected" : "None",
          hint: status.model.detail,
        },
        botItem,
      ],
    },
    {
      title: "Model roles",
      description: "Optional capabilities — unset roles run on the chat model or stay off",
      items: endpointItems,
    },
    {
      title: "Storage",
      description: "Write paths, probed for real",
      items: [tracesItem, downloadsItem],
    },
  ];

  const operational =
    status.db.connected &&
    status.llm.state === "connected" &&
    status.model.selected &&
    status.endpoints.every((endpoint) => endpoint.state !== "error") &&
    status.traces.ok &&
    status.downloads.ok;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>System status</CardTitle>
          <CardDescription>
            Live checks against the database, the configured endpoints, and the write paths.
          </CardDescription>
        </div>
        <CardAction>
          <Badge tone={operational ? "success" : "warning"} dot>
            {operational ? "Operational" : "Setup needed"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-6">
        {groups.map((group) => {
          const summary = groupSummary(group.items);
          return (
            <div key={group.title} className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="text-sm font-semibold tracking-tight">{group.title}</h3>
                <span
                  className={
                    summary.tone === "error"
                      ? "text-xs font-medium text-danger"
                      : summary.tone === "warn"
                        ? "text-xs font-medium text-warning"
                        : "text-xs font-medium text-success"
                  }
                >
                  {summary.text}
                </span>
                <span className="text-xs text-faint">{group.description}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {group.items.map((item) => (
                  <StatusCard
                    key={item.label}
                    label={item.label}
                    value={item.value}
                    tone={item.tone}
                    hint={item.hint}
                  />
                ))}
              </div>
            </div>
          );
        })}

        <div className="flex flex-col gap-2 border-t border-border pt-5">
          <span className="text-sm font-medium text-foreground">Telegram bots</span>
          <BotControl
            initial={connectionsResult.connections}
            serviceError={connectionsResult.error}
            assistantNames={Object.fromEntries(assistants.map((a) => [a.id, a.name]))}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/** The recent/failures/jobs tabs — trace-list and job-board reads. */
async function ActivityTabsSection() {
  const [activity, jobs] = await Promise.all([readActivity(), getAllJobs().catch(() => [])]);
  const stuckJobs = jobs.filter((job) => job.activity === "stopped" || job.failed);
  const runningJobs = jobs.filter((job) => job.activity === "running").length;

  const activityTabs: TabItem[] = [
    {
      id: "recent",
      label: "Recent activity",
      content:
        activity.recent.length > 0 ? (
          <TraceList traces={activity.recent} />
        ) : (
          <EmptyState
            icon={Bug}
            title="Nothing recorded yet"
            description="Every action the bot and the dashboard take shows up here as it happens."
          />
        ),
    },
    {
      id: "failures",
      label: (
        <span className="inline-flex items-center gap-1.5">
          Failures
          {activity.failures.length > 0 ? (
            <Badge tone={activity.failuresInWindow > 0 ? "danger" : "neutral"}>
              {activity.failures.length}
            </Badge>
          ) : null}
        </span>
      ),
      content:
        activity.failures.length > 0 ? (
          <div className="space-y-3">
            {/* The list is not windowed on purpose: the last failure matters
                whether it happened ten minutes or three days ago. */}
            <p className="text-sm text-muted">
              {activity.failuresInWindow > 0
                ? `${activity.failuresInWindow} in the last ${OVERVIEW_WINDOW_HOURS} hours.`
                : `None in the last ${OVERVIEW_WINDOW_HOURS} hours — these are older.`}
            </p>
            <TraceList traces={activity.failures} />
          </div>
        ) : (
          <EmptyState
            icon={CheckCircle2}
            title="No failed traces"
            description="Nothing the bot or the dashboard did has ended in an error."
          />
        ),
    },
    {
      id: "jobs",
      label: (
        <span className="inline-flex items-center gap-1.5">
          Background jobs
          {stuckJobs.length > 0 ? <Badge tone="warning">{stuckJobs.length}</Badge> : null}
        </span>
      ),
      content:
        jobs.length > 0 ? (
          <JobHealthList jobs={jobs} />
        ) : (
          <EmptyState
            icon={AlertTriangle}
            title="Job status unavailable"
            description="No background job reported its state. Open the jobs board for details."
          />
        ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Activity</CardTitle>
          <CardDescription>
            {runningJobs > 0
              ? `${runningJobs} background job${runningJobs === 1 ? "" : "s"} running now.`
              : "The latest traced actions, anything that failed, and every background job."}
          </CardDescription>
        </div>
        <CardAction>
          <Button asChild variant="outline" size="sm" leftIcon={<Bug className="h-4 w-4" />}>
            <Link href="/debug">Debug</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="pt-0">
        <Tabs tabs={activityTabs} />
      </CardContent>
    </Card>
  );
}
