import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { Button, EmptyState, PageHeader } from "@/components/ui";
import { currentAnchor } from "@/features/analytics/period";
import { getAnalyticsJobInfo } from "@/features/analytics/server/scheduler";
import { PERIOD_UNITS, type AnalyticsJobInfo, type PeriodUnit } from "@/features/analytics/types";
import { MOOD_COLORS, SeriesCard } from "@/features/analytics/ui/AnalyticsCharts";
import { AnalyticsJobCard } from "@/features/analytics/ui/AnalyticsJobCard";
import {
  InsightCard,
  ModelTable,
  TopUsersPanel,
  TrafficCard,
} from "@/features/analytics/ui/AnalyticsPanels";
import type { FilterOption } from "@/features/analytics/ui/FilterableCard";
import { RegenerateCard } from "@/features/analytics/ui/RegenerateCard";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { listGroups } from "@/features/known-groups/server/service";
import { listUsers } from "@/features/known-users/server/service";
import { getTimezone } from "@/features/settings/server/service";
import { featureDebugHref } from "@/lib/features";

// Every metric is read live from the database or the trace files at request time.
export const dynamic = "force-dynamic";

interface AnalyticsData {
  job: AnalyticsJobInfo;
  chats: FilterOption[];
  userOptions: FilterOption[];
  todayAnchors: Record<PeriodUnit, string>;
}

/**
 * Analytics dashboard.
 *
 * There is no page-level filter: every card carries its own period and chat/user
 * scope and fetches itself, so you can hold last Tuesday's mood next to this month's
 * token trend. This Server Component supplies only what is shared — the filter option
 * lists, and the current period per unit.
 *
 * Those anchors are resolved **here**, from the operator timezone in Settings, and
 * passed down. The browser's clock must not decide what "today" means on a dashboard
 * describing a bot that lives somewhere else.
 */
export default async function AnalyticsPage() {
  let data: AnalyticsData | null = null;
  let dbError: string | null = null;
  try {
    const [job, users, groups, timezone] = await Promise.all([
      getAnalyticsJobInfo(),
      listUsers(),
      listGroups(),
      getTimezone(),
    ]);
    const now = new Date();
    data = {
      job,
      chats: [
        ...users.map((u) => ({ id: u.userId, label: `${formatKnownUserLabel(u)} · DM` })),
        ...groups.map((g) => ({ id: g.chatId, label: `${g.title ?? `Group ${g.chatId}`} · group` })),
      ],
      userOptions: users.map((u) => ({ id: u.userId, label: formatKnownUserLabel(u) })),
      todayAnchors: Object.fromEntries(
        PERIOD_UNITS.map((unit) => [unit, currentAnchor(unit, now, timezone)]),
      ) as Record<PeriodUnit, string>,
    };
  } catch (err) {
    dbError = err instanceof Error ? err.message : "The analytics data could not be read.";
  }

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Traffic, model performance, and conversation insight. Each card carries its own period. Times use the operator timezone in Settings."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="analytics" />
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("analytics-insights")}>
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
          </div>
        }
      />

      {data ? (
        <>
          <TrafficCard
            chats={data.chats}
            users={data.userOptions}
            todayAnchors={data.todayAnchors}
          />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <InsightCard kind="mood" chats={data.chats} todayAnchors={data.todayAnchors} />
            <InsightCard kind="word" chats={data.chats} todayAnchors={data.todayAnchors} />
            <InsightCard kind="topic" chats={data.chats} todayAnchors={data.todayAnchors} />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <SeriesCard
              section="volume"
              title="Message volume"
              description="Messages sent in each part of the period"
              chats={data.chats}
              users={data.userOptions}
              source="messages"
              todayAnchors={data.todayAnchors}
            />
            <SeriesCard
              section="tokens"
              title="Tokens"
              description="Processed (prompt) vs generated (completion)"
              chats={data.chats}
              users={data.userOptions}
              source="traces"
              todayAnchors={data.todayAnchors}
              area
            />
            {/* No chat or user filter: "new users" is a global fact about a person's
                first sighting, and per-chat activity is what Message volume shows. */}
            <SeriesCard
              section="users"
              title="Users"
              description="Active and newly-seen users"
              source="messages"
              todayAnchors={data.todayAnchors}
            />
            <SeriesCard
              section="mood"
              title="Mood trend"
              description="Conversation mood (0–100) through the period, from the insight job"
              chats={data.chats}
              chatRequired
              source="insights"
              todayAnchors={data.todayAnchors}
              area
              colors={MOOD_COLORS}
              emptyMessage="No mood data yet — the insight job scores each finished hour. Run it from the card below to populate this."
            />
          </div>

          <div className="grid grid-cols-1 gap-4">
            <ModelTable todayAnchors={data.todayAnchors} />
            <TopUsersPanel chats={data.chats} todayAnchors={data.todayAnchors} />
          </div>

          <AnalyticsJobCard job={data.job} />
          <RegenerateCard job={data.job} />
        </>
      ) : (
        <EmptyState
          icon={Database}
          title="Analytics unavailable"
          description={dbError ?? "The analytics data could not be read."}
        />
      )}
    </>
  );
}
