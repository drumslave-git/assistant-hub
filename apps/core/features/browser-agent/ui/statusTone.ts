import type { BadgeTone } from "@/components/ui";

import type { BrowserRunStatus } from "../types";

/** Badge tone + label for a run status, shared by the list and detail views. */
export function runStatusBadge(status: BrowserRunStatus): { tone: BadgeTone; label: string } {
  switch (status) {
    case "queued":
      return { tone: "neutral", label: "Queued" };
    case "running":
      return { tone: "info", label: "Running" };
    case "done":
      return { tone: "success", label: "Done" };
    case "failed":
      return { tone: "danger", label: "Failed" };
  }
}
