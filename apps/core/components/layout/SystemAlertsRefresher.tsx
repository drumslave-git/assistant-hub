"use client";

import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";

/**
 * Invisible subscriber behind {@link SystemAlerts}: re-runs the layout's server
 * read on `status` events so a system alert appears (and clears) live on
 * whatever page the operator is looking at. Always mounted — the whole point of
 * a global alert is learning about the failure while NOT looking at Overview.
 */
export function SystemAlertsRefresher() {
  useLiveRefresh("status");
  return null;
}
