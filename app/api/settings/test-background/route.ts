import { testRoleConnectionSchema } from "@/features/settings/server/schema";
import { testBackground } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Probe the background-jobs role by running the real summarizer over a tiny
 * synthetic chat-day — a model listing cannot say whether a model returns the
 * structured topics the nightly jobs store, which is what this role is for.
 * Backs "Test background model".
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, testRoleConnectionSchema);
  return ok(await testBackground(input, { kind: "dashboard" }));
});
