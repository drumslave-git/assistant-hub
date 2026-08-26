import { AlertTriangle } from "lucide-react";

import type { UnavailableSource } from "@/server/source/directory";

/**
 * The aggregated directory's honesty line: which source apps did not answer
 * this read, and why. A fan-out that silently drops an unreachable source
 * renders an empty (or short) list that reads as "nobody has messaged the
 * bot" — the operator must see the difference between "nothing there" and
 * "could not look".
 *
 * Shared by every aggregated view (people, chats; web chat joins in Phase 4)
 * so one unreachable source is reported the same way everywhere.
 */
export function SourceUnavailableNotice({ sources }: { sources: UnavailableSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="mb-4 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        {sources.length === 1
          ? `${sources[0].sourceLabel} could not be read — this list is incomplete.`
          : `${sources.length} sources could not be read — this list is incomplete.`}
      </div>
      <ul className="mt-1 list-disc pl-6">
        {sources.map((source) => (
          <li key={source.source}>
            <span className="font-medium">{source.sourceLabel}:</span> {source.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
