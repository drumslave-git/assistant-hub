import { Badge, type BadgeTone } from "@/components/ui";
import type { TraceStatus } from "@/lib/trace";

/** Trace status → badge tone. Keeps status colouring identical across Debug views. */
const STATUS_TONE: Record<TraceStatus, BadgeTone> = {
  pending: "neutral",
  running: "info",
  success: "success",
  error: "danger",
  skipped: "warning",
};

/** Shared status pill for a trace or job. */
export function TraceStatusBadge({ status }: { status: TraceStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot>
      {status}
    </Badge>
  );
}
