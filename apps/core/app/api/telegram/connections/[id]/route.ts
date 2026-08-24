import { z } from "zod";

import { defineRoute, ok, parseJson } from "@/server/http";
import {
  deleteSourceConnection,
  updateSourceConnection,
} from "@/server/source/tg-operator";

/** One connection: desired-state changes and removal (see ../route.ts). */

const updateSchema = z
  .object({
    botToken: z.string().trim().min(1).max(200),
    enabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide botToken or enabled",
  });

export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updateSchema);
  return ok({ connection: await updateSourceConnection(params.id, input) });
});

export const DELETE = defineRoute(async ({ params }) => {
  await deleteSourceConnection(params.id);
  return ok({ deleted: true });
});
