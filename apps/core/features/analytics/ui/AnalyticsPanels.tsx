"use client";

import {
  AlertTriangle,
  Cpu,
  Gauge,
  MessageSquare,
  Sparkles,
  Users,
} from "lucide-react";

import {
  Badge,
  StatCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  type BadgeTone,
} from "@/components/ui";
import { Timestamp } from "@/components/time/Timestamp";

import { formatCompact, formatMs, formatNumber } from "../format";
import { callKindLabel } from "../llm-call-kind";
import {
  GRANULARITY_LABELS,
  type CallKindStat,
  type CardFilters,
  type ModelsPayload,
  type ModelStat,
  type PeriodInsight,
  type PeriodUnit,
  type TopUsersPayload,
  type TotalsPayload,
} from "../types";
import { CardBody, FilterableCard, type FilterOption } from "./FilterableCard";
import { useCardData } from "./useCardData";

/** Badge tone for a mood score. */
function moodTone(score: number): BadgeTone {
  if (score >= 60) return "success";
  if (score >= 45) return "neutral";
  if (score >= 25) return "warning";
  return "danger";
}

/** Names the exact period a card is showing — "Day 2026-07-15", not "the day". */
function periodLabel(unit: PeriodUnit, anchor: string): string {
  return unit === "all" ? "All time" : `${GRANULARITY_LABELS[unit]} ${anchor}`;
}

/** Props every filtered card needs from the page. */
export interface CardShellProps {
  todayAnchors: Record<PeriodUnit, string>;
}

/* ------------------------------------------------------------------------- *
 * Traffic — the bot's workload, from the trace files.
 * ------------------------------------------------------------------------- */

/**
 * The traffic tiles. The tiles share one filter rather than carrying one each: they
 * are one measurement of one period from several angles, and a filter bar per tile
 * would be larger than the tile it filtered.
 */
export function TrafficCard({
  chats,
  users,
  todayAnchors,
}: CardShellProps & { chats: FilterOption[]; users: FilterOption[] }) {
  return (
    <FilterableCard
      title="Traffic"
      description="What the bot handled in this period, from its traces"
      chats={chats}
      users={users}
      source="traces"
      todayAnchors={todayAnchors}
    >
      {(filters) => <TrafficBody filters={filters} />}
    </FilterableCard>
  );
}

function TrafficBody({ filters }: { filters: CardFilters }) {
  const { data, error, loading } = useCardData<TotalsPayload>("/api/analytics/metrics", filters);
  return (
    <CardBody
      loading={loading}
      error={error}
      hasData={data != null}
      emptyMessage="No traffic in this period."
    >
      {data ? <TrafficTiles payload={data} /> : null}
    </CardBody>
  );
}

function TrafficTiles({ payload }: { payload: TotalsPayload }) {
  const t = payload.totals;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <StatCard
        label="Messages handled"
        value={formatNumber(t.handled)}
        icon={MessageSquare}
        accent
        hint={`${formatNumber(t.replied)} replied`}
      />
      <StatCard
        label="Tokens processed"
        value={formatCompact(t.tokensProcessed)}
        icon={Cpu}
        hint="Prompt tokens in"
      />
      <StatCard
        label="Tokens generated"
        value={formatCompact(t.tokensGenerated)}
        icon={Cpu}
        hint="Completion tokens out"
      />
      <StatCard
        label="Active users"
        value={formatNumber(t.activeUsers)}
        icon={Users}
        hint={`${formatNumber(t.images)} images described`}
      />
      <StatCard
        label="Failed"
        value={formatNumber(t.failed)}
        icon={AlertTriangle}
        hint="Traces that ended in an error"
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Insight cards — mood, word of the period, top topic. Always one chat.
 * ------------------------------------------------------------------------- */

/** Which stored insight field a card shows — the three cards differ only in this. */
type InsightKind = "mood" | "word" | "topic";

/**
 * One LLM-derived insight card, with its own period and chat.
 *
 * There is no user filter and no "All chats": an insight is scored from a whole
 * conversation, so there is no per-person slice to read, and averaging unrelated
 * chats produces a number describing nobody. Both controls used to be present and
 * both were inert.
 */
export function InsightCard({
  kind,
  chats,
  todayAnchors,
}: CardShellProps & { kind: InsightKind; chats: FilterOption[] }) {
  const title = kind === "mood" ? "Mood" : kind === "word" ? "Word of the period" : "Top topic";
  const description =
    kind === "mood"
      ? "Message-weighted conversation mood"
      : kind === "word"
        ? "The period distilled to one word"
        : "What was discussed most";
  return (
    <FilterableCard
      title={title}
      description={description}
      chats={chats}
      chatRequired
      source="insights"
      todayAnchors={todayAnchors}
    >
      {(filters) => <InsightBody kind={kind} filters={filters} />}
    </FilterableCard>
  );
}

function InsightBody({ kind, filters }: { kind: InsightKind; filters: CardFilters }) {
  const { data, error, loading } = useCardData<PeriodInsight | null>(
    "/api/analytics/insights",
    filters,
  );
  return (
    <CardBody
      loading={loading}
      error={error}
      hasData={data != null}
      emptyMessage={
        filters.chatId
          ? "Not computed yet — the insight job scores each finished hour."
          : "Pick a chat to see its insight."
      }
    >
      {data ? <InsightValue kind={kind} insight={data} /> : null}
    </CardBody>
  );
}

function InsightValue({ kind, insight }: { kind: InsightKind; insight: PeriodInsight }) {
  if (kind === "mood") {
    const mood = insight.mood;
    if (!mood) return <p className="py-8 text-center text-sm text-muted">No scored hours yet.</p>;
    return (
      <div className="space-y-2">
        <div className="flex items-end gap-2">
          <Gauge className="mb-1.5 h-4 w-4 text-muted" aria-hidden />
          <span className="text-3xl font-semibold tabular-nums">{mood.moodScore}</span>
          <Badge tone={moodTone(mood.moodScore)} className="mb-1">
            {mood.moodLabel}
          </Badge>
        </div>
        <p className="text-xs text-faint">
          {periodLabel(insight.unit, insight.anchor)} · weighted across {mood.sourceUnits} hour(s) ·{" "}
          {formatNumber(mood.messageCount)} messages
        </p>
      </div>
    );
  }

  const value = kind === "word" ? insight.wordOfPeriod : insight.topTopic;
  const Icon = kind === "word" ? Sparkles : MessageSquare;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <p
          className={
            kind === "word" ? "text-2xl font-semibold break-words" : "text-lg font-medium break-words"
          }
        >
          {value}
        </p>
      </div>
      <p className="text-xs text-faint">
        {periodLabel(insight.unit, insight.anchor)} · computed{" "}
        <Timestamp iso={insight.computedAt} /> · {insight.model}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Model performance — every kind of LLM call, separately.
 * ------------------------------------------------------------------------- */

/**
 * Model performance for the selected period.
 *
 * Rows are **call kinds**, not models or trace features: one model serves the
 * addressing check, each tool turn of a reply, the reply itself, image descriptions
 * and the nightly insight passes, and a single per-model average of that mix tracked
 * the mix rather than the model. Latency therefore lives on the kind, never on the
 * model row.
 *
 * Ordering is by **total time contributed**, so the row at the top is the one that
 * actually costs the most wall clock — the bottleneck. Sorting by call count buried
 * a slow-but-frequent step under a fast-and-frequent one.
 */
export function ModelTable({ todayAnchors }: CardShellProps) {
  return (
    <FilterableCard
      title="Model performance"
      description="Every LLM call in the period, by model and by what the call was for"
      source="traces"
      todayAnchors={todayAnchors}
    >
      {(filters) => <ModelTableBody filters={filters} />}
    </FilterableCard>
  );
}

function ModelTableBody({ filters }: { filters: CardFilters }) {
  const { data, error, loading } = useCardData<ModelsPayload>("/api/analytics/models", filters);
  return (
    <CardBody
      loading={loading}
      error={error}
      hasData={data != null && data.models.length > 0}
      emptyMessage="No LLM calls recorded in this period."
    >
      {data ? <ModelRows models={data.models} /> : null}
    </CardBody>
  );
}

/**
 * Why this column is not a model benchmark.
 *
 * It is `completionTokens / latency`, summed over calls made at different times,
 * and latency on a shared endpoint includes time spent queued behind other work.
 * So it reports how busy the box was while a model happened to be in use. A
 * rarely-used model that ran mostly during quiet periods will out-score the
 * everyday one on the same hardware — which is exactly how it was misread once
 * (2026-08-07: a 26B model showed 2.3x the 12B's rate here, and lost to it on
 * every call shape in a controlled benchmark).
 */
const TOKENS_PER_SEC_NOTE =
  "Completion tokens per second of measured latency, which includes time queued " +
  "behind other work on a shared endpoint. Higher usually means the endpoint was " +
  "quieter, not that the model is faster — do not compare models with it.";

function ModelRows({ models }: { models: ModelStat[] }) {
  return (
    <>
    <Table minWidth={800}>
      <TableHead>
        <TableRow header>
          <TableHeaderCell>Model / call kind</TableHeaderCell>
          <TableHeaderCell align="right">Calls</TableHeaderCell>
          <TableHeaderCell align="right">Total time</TableHeaderCell>
          <TableHeaderCell align="right">Avg</TableHeaderCell>
          <TableHeaderCell align="right">p50</TableHeaderCell>
          <TableHeaderCell align="right">p95</TableHeaderCell>
          <TableHeaderCell
            align="right"
            title={TOKENS_PER_SEC_NOTE}
            className="cursor-help underline decoration-dotted underline-offset-4"
          >
            Tokens/s
          </TableHeaderCell>
          <TableHeaderCell align="right">Prompt</TableHeaderCell>
          <TableHeaderCell align="right">Completion</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {models.map((m) => [
          <TableRow key={m.model}>
            <TableCell className="font-medium">{m.model}</TableCell>
            <TableCell align="right" className="tabular-nums">
              {formatNumber(m.calls)}
            </TableCell>
            <TableCell align="right" className="tabular-nums">
              {formatMs(m.totalLatencyMs)}
            </TableCell>
            {/* A model-wide latency mean would average unlike kinds of call. */}
            <TableCell align="right" className="text-faint">
              —
            </TableCell>
            <TableCell align="right" className="text-faint">
              —
            </TableCell>
            <TableCell align="right" className="text-faint">
              —
            </TableCell>
            <TableCell align="right" className="tabular-nums">
              {m.tokensPerSec ?? "—"}
            </TableCell>
            <TableCell align="right" className="tabular-nums">
              {formatCompact(m.promptTokens)}
            </TableCell>
            <TableCell align="right" className="tabular-nums">
              {formatCompact(m.completionTokens)}
            </TableCell>
          </TableRow>,
          ...m.callKinds.map((k) => <CallKindRow key={`${m.model}:${k.callKind}`} stat={k} />),
        ])}
      </TableBody>
    </Table>
    <p className="mt-3 text-xs text-faint">
      Tokens/s counts queue time, so it reflects how busy the endpoint was rather
      than how fast a model is. Benchmark models directly instead of comparing
      this column.
    </p>
    </>
  );
}

function CallKindRow({ stat }: { stat: CallKindStat }) {
  return (
    <TableRow>
      <TableCell className="pl-8 text-muted">{callKindLabel(stat.callKind)}</TableCell>
      <TableCell align="right" className="tabular-nums">
        {formatNumber(stat.calls)}
      </TableCell>
      <TableCell align="right" className="tabular-nums">
        {formatMs(stat.totalLatencyMs)}
      </TableCell>
      <TableCell align="right" className="tabular-nums">
        {formatMs(stat.avgLatencyMs)}
      </TableCell>
      <TableCell align="right" className="tabular-nums">
        {stat.latencyP50 === null ? "—" : formatMs(stat.latencyP50)}
      </TableCell>
      <TableCell align="right" className="tabular-nums">
        {stat.latencyP95 === null ? "—" : formatMs(stat.latencyP95)}
      </TableCell>
      <TableCell align="right" className="tabular-nums">
        {stat.tokensPerSec ?? "—"}
      </TableCell>
      <TableCell align="right" className="tabular-nums">
        {formatCompact(stat.promptTokens)}
      </TableCell>
      <TableCell align="right" className="tabular-nums">
        {formatCompact(stat.completionTokens)}
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------------------- *
 * Top users.
 * ------------------------------------------------------------------------- */

/** The most active people in the selected period. */
export function TopUsersPanel({
  chats,
  todayAnchors,
}: CardShellProps & { chats: FilterOption[] }) {
  return (
    <FilterableCard
      title="Top users"
      description="Most active senders in this period"
      chats={chats}
      source="messages"
      todayAnchors={todayAnchors}
    >
      {(filters) => <TopUsersBody filters={filters} />}
    </FilterableCard>
  );
}

function TopUsersBody({ filters }: { filters: CardFilters }) {
  const { data, error, loading } = useCardData<TopUsersPayload>(
    "/api/analytics/top-users",
    filters,
  );
  return (
    <CardBody
      loading={loading}
      error={error}
      hasData={data != null && data.users.length > 0}
      emptyMessage="No messages in this period."
    >
      {data ? (
        <Table minWidth={360}>
          <TableHead>
            <TableRow header>
              <TableHeaderCell>User</TableHeaderCell>
              <TableHeaderCell align="right">Messages</TableHeaderCell>
              <TableHeaderCell align="right">Tokens</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.users.map((u) => (
              <TableRow key={u.userId}>
                <TableCell className="font-medium">{u.label}</TableCell>
                <TableCell align="right" className="tabular-nums">
                  {formatNumber(u.messages)}
                </TableCell>
                <TableCell align="right" className="tabular-nums">
                  {formatCompact(u.tokens)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </CardBody>
  );
}
