import { getDb } from "@/db/drizzle";
import { getBrowserRunScreenshot } from "@/features/browser-agent/server/repository";
import { ApiError } from "@/lib/api-error";
import { defineRoute } from "@/server/http";

/**
 * Serve one browser-run screenshot's JPEG bytes by `(run, seq)`. The bytes live
 * in Postgres (never in trace JSON, per the binary-payload convention); this is
 * how the dashboard run view renders them. Auth-gated like every other route.
 */
export const GET = defineRoute(async ({ params }) => {
  const seq = Number(params.seq);
  if (!Number.isInteger(seq) || seq < 0) throw ApiError.badRequest("Invalid screenshot sequence");
  const data = await getBrowserRunScreenshot(getDb(), params.id, seq);
  if (!data) throw ApiError.notFound("Screenshot not found");
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=3600",
    },
  });
});
