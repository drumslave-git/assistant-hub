import { z } from "zod";

import { defineRoute, ok, parseJson } from "@/server/http";
import {
  deleteChatThread,
  getChatThread,
  renameChatThread,
} from "@/features/web-chat/server/service";

/** One web-chat thread: its transcript, its name, or its removal. */

const renameSchema = z.object({ name: z.string().trim().min(1).max(120) });

export const GET = defineRoute(async ({ params }) => {
  return ok(await getChatThread(params.id));
});

export const PATCH = defineRoute(async ({ request, params }) => {
  const { name } = await parseJson(request, renameSchema);
  return ok({ thread: await renameChatThread(params.id, name) });
});

export const DELETE = defineRoute(async ({ params }) => {
  await deleteChatThread(params.id);
  return ok({ deleted: true });
});
