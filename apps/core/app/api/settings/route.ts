import { updateSettingsSchema } from "@/features/settings/server/schema";
import { getSettings, updateSettings } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Settings API. Thin handlers: shared wrappers own validation and error mapping;
 * the service owns persistence, secret masking, and trace recording.
 */

export const GET = defineRoute(async () => ok(await getSettings()));

export const PATCH = defineRoute(async ({ request }) => {
  const patch = await parseJson(request, updateSettingsSchema);
  return ok(await updateSettings(patch, { kind: "dashboard" }));
});
