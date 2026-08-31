import { buildInfo } from "@/lib/build-info";
import { defineRoute } from "@/server/http";
import { getHealth } from "@/server/status";

// Always evaluate the probe at request time.
export const dynamic = "force-dynamic";

/**
 * Liveness + readiness endpoint. Readiness is a real database probe (`SELECT 1`),
 * not an env-presence guess: `200` when the app can serve, `503` when its
 * bootstrap dependency (the DB) is down — so orchestrators react correctly. The
 * body also reports DB-stored configuration presence (informational; the LLM is
 * not a readiness gate).
 */
// Public: the Docker healthcheck and orchestrators probe this without a session.
export const GET = defineRoute(async () => {
  const health = await getHealth();
  return Response.json(
    {
      status: health.ready ? "ok" : "unavailable",
      time: new Date().toISOString(),
      version: buildInfo.version,
      checks: {
        database: health.database,
        configuration: health.configuration,
        // Informational, not a readiness gate: restart-looping the container on
        // an unwritable volume would drop the RAM-buffered traces (see getHealth).
        traceStorage: health.traceStorage,
        // Informational too: an unwritable downloads mount breaks only the browser
        // agent's downloads, and does so loudly on the run that attempted one.
        downloadStorage: health.downloadStorage,
      },
    },
    { status: health.ready ? 200 : 503 },
  );
}, { access: "public" });
