"use client";

import type { ECharts, EChartsOption } from "echarts";
import { useEffect, useRef, useState } from "react";

import { DARK_THEME, LIGHT_THEME, type ChartTheme } from "./chart-theme";

/**
 * The one ECharts wrapper every analytics chart goes through. A Client Component
 * (canvas has no SSR) that lazy-`import("echarts")` on mount, so the ~1MB library
 * never enters the server bundle. This module is only ever loaded on the client
 * (its callers pull it in via `next/dynamic({ ssr: false })`), keeping ECharts out
 * of the server render entirely.
 *
 * Theming is explicit, not automatic: the caller builds its `option` from the
 * supplied {@link ChartTheme} (the data-viz skill's validated per-mode steps). The
 * chart re-renders — without re-init — when the option or the theme changes, and
 * follows the dashboard's light/dark toggle live.
 */

/** Resolve the active theme from the app's `data-theme` stamp / OS preference. */
function currentIsDark(): boolean {
  if (typeof document === "undefined") return false;
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function Chart({
  buildOption,
  height = 260,
  ariaLabel,
}: {
  /** Build the ECharts option from the resolved theme. Memoize with `useMemo`. */
  buildOption: (theme: ChartTheme) => EChartsOption;
  height?: number;
  ariaLabel?: string;
}) {
  const divRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const [ready, setReady] = useState(false);
  // Lazy init (not a synchronous setState-in-effect): safe during SSR via the
  // `document` guard; the observers below catch every later theme change.
  const [isDark, setIsDark] = useState(currentIsDark);

  // Track the active theme and re-render on toggle / OS change.
  useEffect(() => {
    const observer = new MutationObserver(() => setIsDark(currentIsDark()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMedia = () => setIsDark(currentIsDark());
    media.addEventListener("change", onMedia);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", onMedia);
    };
  }, []);

  // Init once; dispose on unmount.
  useEffect(() => {
    let disposed = false;
    let resize: ResizeObserver | null = null;
    void (async () => {
      const echarts = await import("echarts");
      if (disposed || !divRef.current) return;
      chartRef.current = echarts.init(divRef.current, undefined, { renderer: "canvas" });
      resize = new ResizeObserver(() => chartRef.current?.resize());
      resize.observe(divRef.current);
      setReady(true);
    })();
    return () => {
      disposed = true;
      resize?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  // Re-apply the option whenever it or the theme changes (no re-init).
  useEffect(() => {
    if (!ready || !chartRef.current) return;
    chartRef.current.setOption(buildOption(isDark ? DARK_THEME : LIGHT_THEME), true);
  }, [ready, isDark, buildOption]);

  return <div ref={divRef} style={{ height }} role="img" aria-label={ariaLabel} />;
}
