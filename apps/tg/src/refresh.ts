import { randomUUID } from "node:crypto";

import { dashboardRefreshEventSchema, type DashboardRefreshEvent } from "@assistant-hub/contracts";

/**
 * Build one dashboard live-refresh ping. Published wherever this app
 * changes what a dashboard page shows — the mirror, the directory, the
 * poller statuses, the feedback rows — so the core can bridge it to its
 * SSE layer and no page ever needs a manual reload.
 */
export function dashboardRefresh(topics: string[]): DashboardRefreshEvent {
  return dashboardRefreshEventSchema.parse({
    v: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: "tg:refresh",
    type: "dashboard.refresh",
    source: "tg",
    topics,
  });
}
