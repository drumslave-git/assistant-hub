import { z } from "zod";

import { getSourceBotStatus, setSourceBotEnabled } from "@/server/source/tg-operator";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Telegram bot control API. Thin handlers over the tg source app's operator
 * API (the poller lives there since the source split): `GET` reports the
 * connection's actual state; `POST { action }` writes the desired state and
 * the tg app reconciles. The token is managed in Settings, so start needs
 * no request body.
 */

const controlSchema = z.object({ action: z.enum(["start", "stop"]) });

export const GET = defineRoute(async () => ok((await getSourceBotStatus()).status));

export const POST = defineRoute(async ({ request }) => {
  const { action } = await parseJson(request, controlSchema);
  return ok(await setSourceBotEnabled(action === "start"));
});
