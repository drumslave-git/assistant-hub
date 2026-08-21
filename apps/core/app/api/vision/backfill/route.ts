import {
  getVisionBackfillStatus,
  runVisionBackfillNow,
} from "@/features/vision/server/backfill-scheduler";
import { getPendingMediaCount } from "@/features/vision/server/service";
import { defineRoute, ok } from "@/server/http";

/**
 * Vision backfill control API. Thin handlers over the in-process scheduler:
 * `GET` reports the scheduler status plus how many media rows are still pending;
 * `POST` triggers a run as soon as possible ("Run now"). The job reads its LLM
 * connection from DB settings, so neither needs a request body.
 */

async function snapshot() {
  const pending = await getPendingMediaCount();
  return { status: getVisionBackfillStatus(), pending };
}

export const GET = defineRoute(async () => ok(await snapshot()));

export const POST = defineRoute(async () => {
  runVisionBackfillNow();
  return ok(await snapshot());
});
