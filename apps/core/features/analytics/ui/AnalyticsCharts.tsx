"use client";

import type { EChartsOption } from "echarts";
import dynamic from "next/dynamic";
import { useCallback } from "react";

import { formatCompact } from "../format";
import {
  CHART_PERIOD_UNITS,
  type CardFilters,
  type Granularity,
  type MetricSource,
  type NamedSeries,
  type PeriodUnit,
  type SeriesPayload,
  type SeriesSection,
} from "../types";
import { STATUS, type ChartTheme } from "./chart-theme";
import { CardBody, FilterableCard, type FilterOption } from "./FilterableCard";
import { useCardData } from "./useCardData";

// The chart is canvas-bound (ECharts): load it client-only so ECharts never
// enters the server render. Reserves the height to avoid layout shift.
const Chart = dynamic(() => import("./Chart").then((m) => m.Chart), {
  ssr: false,
  loading: () => <div style={{ height: 260 }} aria-hidden />,
});

/**
 * Shorten a sub-bucket key for an axis tick.
 *
 * The axis is always *inside* one period, so the enclosing period is already named on
 * the card's own control — repeating it on every tick is noise. An hour shows as
 * `14:00`, a day within a month as `07-15`.
 */
function shortBucket(label: string, bucketUnit: Granularity): string {
  switch (bucketUnit) {
    case "hour":
      // "2026-07-15 14" → "14:00"
      return `${label.slice(11)}:00`;
    case "day":
    case "week":
      // "2026-07-15" → "07-15"
      return label.slice(5);
    case "month":
      // "2026-07" → "07"
      return label.slice(5);
    case "year":
      return label;
    case "all":
      return "All time";
  }
}

/** Shared line-chart option builder themed from the resolved palette. */
function lineOption(
  theme: ChartTheme,
  input: {
    buckets: string[];
    bucketUnit: Granularity;
    series: NamedSeries[];
    yMax?: number;
    area?: boolean;
    colors?: string[];
  },
): EChartsOption {
  const multi = input.series.length > 1;
  return {
    grid: { left: 8, right: 16, top: multi ? 34 : 12, bottom: 4, containLabel: true },
    color: input.series.map((_, i) => input.colors?.[i] ?? theme.series[i]),
    legend: multi
      ? { show: true, top: 0, left: 0, itemWidth: 12, itemHeight: 4, textStyle: { color: theme.secondary, fontSize: 12 } }
      : undefined,
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.tooltipBg,
      borderColor: theme.grid,
      textStyle: { color: theme.ink, fontSize: 12 },
      axisPointer: { type: "line", lineStyle: { color: theme.baseline } },
    },
    xAxis: {
      type: "category",
      data: input.buckets.map((b) => shortBucket(b, input.bucketUnit)),
      boundaryGap: false,
      axisLine: { lineStyle: { color: theme.baseline } },
      axisTick: { show: false },
      axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      max: input.yMax,
      splitLine: { lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => formatCompact(v) },
    },
    series: input.series.map((s) => ({
      name: s.name,
      type: "line" as const,
      data: s.data,
      smooth: false,
      // A lone point would be invisible as a line, and a series with gaps (mood
      // only exists for scored days) needs its islands marked.
      showSymbol: input.buckets.length <= 1 || s.data.some((v) => v === null),
      connectNulls: false,
      lineStyle: { width: 2 },
      areaStyle: input.area ? { opacity: 0.12 } : undefined,
    })),
  };
}

function ChartFor({
  payload,
  area,
  colors,
}: {
  payload: SeriesPayload;
  area?: boolean;
  colors?: string[];
}) {
  const { buckets, bucketUnit, series, yMax } = payload;
  const build = useCallback(
    (theme: ChartTheme) => lineOption(theme, { buckets, bucketUnit, series, yMax, area, colors }),
    [buckets, bucketUnit, series, yMax, area, colors],
  );
  return <Chart buildOption={build} ariaLabel={payload.section} />;
}

/**
 * One filtered chart card. Every series section answers with the same
 * `{ buckets, series }` shape, so this single component is every chart on the
 * dashboard — message volume, tokens, users, and the mood trend differ only by which
 * section they ask for, which filters they honour, and how they are titled.
 *
 * Chart cards never offer the `all` period: it has no bounded axis, so it drew a
 * single dot and called it a trend.
 */
export function SeriesCard({
  section,
  title,
  description,
  chats,
  users,
  chatRequired,
  source,
  todayAnchors,
  area,
  colors,
  emptyMessage = "No data for this period.",
}: {
  section: SeriesSection;
  title: string;
  description?: string;
  chats?: FilterOption[];
  users?: FilterOption[];
  chatRequired?: boolean;
  source: MetricSource;
  todayAnchors: Record<PeriodUnit, string>;
  area?: boolean;
  colors?: string[];
  emptyMessage?: string;
}) {
  return (
    <FilterableCard
      title={title}
      description={description}
      chats={chats}
      users={users}
      chatRequired={chatRequired}
      units={CHART_PERIOD_UNITS}
      source={source}
      todayAnchors={todayAnchors}
    >
      {(filters) => (
        <SeriesBody
          section={section}
          filters={filters}
          area={area}
          colors={colors}
          emptyMessage={emptyMessage}
        />
      )}
    </FilterableCard>
  );
}

function SeriesBody({
  section,
  filters,
  area,
  colors,
  emptyMessage,
}: {
  section: SeriesSection;
  filters: CardFilters;
  area?: boolean;
  colors?: string[];
  emptyMessage: string;
}) {
  const { data, error, loading } = useCardData<SeriesPayload>("/api/analytics/series", filters, {
    section,
  });
  // A series of nothing but gaps has no chart to draw — say so rather than
  // rendering empty axes.
  const hasData = data != null && data.series.some((s) => s.data.some((v) => v !== null));
  return (
    <CardBody loading={loading} error={error} hasData={hasData} emptyMessage={emptyMessage}>
      {data ? <ChartFor payload={data} area={area} colors={colors} /> : null}
    </CardBody>
  );
}

/** The mood trend's line is tied to the mood palette, not the generic series slots. */
export const MOOD_COLORS = [STATUS.good];
