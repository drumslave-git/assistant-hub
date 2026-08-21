import { AlertTriangle } from "lucide-react";

import { Timestamp } from "@/components/time/Timestamp";
import { getTraceStorageHealth } from "@/server/trace/store";

import { SystemAlertsRefresher } from "./SystemAlertsRefresher";

/**
 * Global system alerts, rendered by the dashboard layout above every page.
 *
 * Reserved for failures that silently destroy data if the operator does not
 * act — currently one: the trace write path. A flush failure used to exist only
 * as a server-log line while settled traces piled up in RAM and vanished on the
 * next restart; this banner makes that state impossible to miss from any
 * dashboard page. Per-feature degradations (LLM down, bot stopped) stay on
 * their own pages/cards — this surface must stay rare to stay loud.
 */
export async function SystemAlerts() {
  const traces = await getTraceStorageHealth();

  return (
    <>
      <SystemAlertsRefresher />
      {traces.ok ? null : (
        <div
          role="alert"
          className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          <div className="flex items-center gap-2 font-medium text-danger">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            Trace storage is failing — logs are not being persisted
          </div>
          <p className="mt-1 text-danger/90">{traces.detail}</p>
          <p className="mt-1 text-muted">
            {traces.pendingCount} settled trace(s) are buffered in memory
            {traces.lastFlushError ? (
              <>
                {" "}
                (failing since <Timestamp iso={traces.lastFlushError.at} />)
              </>
            ) : null}{" "}
            and will be lost if the app restarts. Make the traces directory
            writable by the app user (for a Docker bind mount, fix the host
            directory&apos;s ownership) — buffered traces flush automatically
            once writing succeeds.
          </p>
        </div>
      )}
    </>
  );
}
