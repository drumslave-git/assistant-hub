import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { defineRoute, ok, parseJson } from "@/server/http";
import {
  deleteChatThread,
  getChatThread,
  renameChatThread,
} from "@/features/web-chat/server/service";

/** One web-chat thread: its transcript, its name, or its removal. */

const renameSchema = z.object({ name: z.string().trim().min(1).max(120) });

export const GET = defineRoute(async ({ params, account }) => {
  if (!account) throw ApiError.unauthorized("Sign in to chat");
  return ok(await getChatThread(params.id, account.id));
}, { access: "account" });

export const PATCH = defineRoute(async ({ request, params, account }) => {
  if (!account) throw ApiError.unauthorized("Sign in to chat");
  const { name } = await parseJson(request, renameSchema);
  return ok({ thread: await renameChatThread(params.id, name, account.id) });
}, { access: "account" });

export const DELETE = defineRoute(async ({ params, account }) => {
  if (!account) throw ApiError.unauthorized("Sign in to chat");
  await deleteChatThread(params.id, account.id);
  return ok({ deleted: true });
}, { access: "account" });
