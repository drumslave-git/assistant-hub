import {
  getMessageIndexingStatus,
  runMessageIndexingNow,
} from "@/features/history/server/index-scheduler";
import { requireSourceContent } from "@/server/source/content";
import { defineRoute, ok } from "@/server/http";

/**
 * Message search-index control API. Thin handlers over the in-process scheduler,
 * mirroring the vision-backfill route: `GET` reports the scheduler status plus
 * how many messages are still awaiting indexing, `POST` triggers a run as soon as
 * possible ("Index now"), and `DELETE` empties the index and arms a rebuild —
 * the recovery path for a chat indexed before an embedding model was configured
 * (see `clearMessageIndex`). The job reads its embedding connection from DB
 * settings, so none of them needs a request body.
 */

async function snapshot() {
  const { total: pending } = await requireSourceContent().indexDue(0);
  return { status: getMessageIndexingStatus(), pending };
}

export const GET = defineRoute(async () => ok(await snapshot()));

export const POST = defineRoute(async () => {
  runMessageIndexingNow();
  return ok(await snapshot());
});

export const DELETE = defineRoute(async () => {
  const cleared = await requireSourceContent().clearIndex();
  runMessageIndexingNow();
  return ok({ ...(await snapshot()), cleared });
});
