/**
 * Comparing what a remote MCP server offers now against what the operator
 * applied. Pure functions (no server-only marker) — unit-tested directly.
 *
 * The whole point of the phase's snapshot rule (user decision, 2026-08-28)
 * lives here: discovery produces a REPORT, never an edit. What the model is
 * offered moves only when an operator applies the set they reviewed.
 */

/** A tool as either side describes it: applied snapshot or fresh discovery. */
export interface ComparableTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What changed between the applied snapshot and the discovered toolset. */
export interface ToolsetDiff {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
}

/**
 * Stable JSON for schema comparison: object keys are sorted recursively, so
 * a server that serializes its schema in a different key order does not read
 * as a change the operator has to review.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(",")}}`;
}

/** Whether two descriptions of the same tool are the same offer. */
export function sameTool(a: ComparableTool, b: ComparableTool): boolean {
  return a.description === b.description && canonical(a.inputSchema) === canonical(b.inputSchema);
}

/** Diff a discovered toolset against the applied snapshot, by tool name. */
export function diffToolsets(
  applied: readonly ComparableTool[],
  discovered: readonly ComparableTool[],
): ToolsetDiff {
  const appliedByName = new Map(applied.map((tool) => [tool.name, tool]));
  const diff: ToolsetDiff = { added: [], changed: [], removed: [], unchanged: [] };

  for (const tool of discovered) {
    const before = appliedByName.get(tool.name);
    if (!before) diff.added.push(tool.name);
    else if (sameTool(before, tool)) diff.unchanged.push(tool.name);
    else diff.changed.push(tool.name);
  }
  const discoveredNames = new Set(discovered.map((tool) => tool.name));
  for (const tool of applied) {
    if (!discoveredNames.has(tool.name)) diff.removed.push(tool.name);
  }

  for (const list of Object.values(diff)) list.sort();
  return diff;
}

/** Whether a diff asks the operator for anything. */
export function hasDrift(diff: ToolsetDiff): boolean {
  return diff.added.length > 0 || diff.changed.length > 0 || diff.removed.length > 0;
}

/** One-line summary of a diff, for trace summaries and the dashboard. */
export function describeDiff(diff: ToolsetDiff): string {
  if (!hasDrift(diff)) return `${diff.unchanged.length} tools, unchanged`;
  const parts: string[] = [];
  if (diff.added.length) parts.push(`${diff.added.length} added`);
  if (diff.changed.length) parts.push(`${diff.changed.length} changed`);
  if (diff.removed.length) parts.push(`${diff.removed.length} gone`);
  return parts.join(", ");
}
