/**
 * Chart theme tokens — pure data/types with no ECharts import, so this can be
 * evaluated on the server (for the categorical hues + `ChartTheme` type) while the
 * canvas-bound {@link import("./Chart")} component stays client-only.
 *
 * Values are the data-viz skill's validated per-mode steps: a dark theme is its
 * own selected palette, not a flipped light one.
 */

export interface ChartTheme {
  isDark: boolean;
  /** Primary text. */
  ink: string;
  /** Secondary/label text. */
  secondary: string;
  /** Axis-tick / muted text. */
  muted: string;
  /** Hairline gridlines. */
  grid: string;
  /** Baseline / axis line. */
  baseline: string;
  /** Categorical series slots, in fixed order (never cycled). */
  series: string[];
  /** Tooltip surface. */
  tooltipBg: string;
}

export const LIGHT_THEME: ChartTheme = {
  isDark: false,
  ink: "#0b0b0b",
  secondary: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  baseline: "#c3c2b7",
  series: ["#2a78d6", "#1baf7a", "#eda100", "#4a3aa7"],
  tooltipBg: "#ffffff",
};

export const DARK_THEME: ChartTheme = {
  isDark: true,
  ink: "#ffffff",
  secondary: "#c3c2b7",
  muted: "#898781",
  grid: "#2c2c2a",
  baseline: "#383835",
  series: ["#3987e5", "#199e70", "#c98500", "#9085e9"],
  tooltipBg: "#262624",
};

/** Fixed status hues (never themed) — for mood/health marks. */
export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;
