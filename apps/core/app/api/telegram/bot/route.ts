import { z } from "zod";

import { getBotStatus, startBot, stopBot } from "@/server/telegram/bot-manager";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Telegram bot control API. Thin handlers over the in-process bot manager:
 * `GET` reports current status; `POST { action }` starts or stops the poller.
 * The bot reads its token from DB settings, so start needs no request body.
 */

const controlSchema = z.object({ action: z.enum(["start", "stop"]) });

export const GET = defineRoute(async () => ok(getBotStatus()));

export const POST = defineRoute(async ({ request }) => {
  const { action } = await parseJson(request, controlSchema);
  const status = action === "start" ? await startBot() : await stopBot();
  return ok(status);
});
