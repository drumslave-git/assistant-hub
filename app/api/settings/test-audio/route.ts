import { testRoleConnectionSchema } from "@/features/settings/server/schema";
import { testAudio } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Probe the audio (STT) role by transcribing a fraction of a second of
 * generated silence — a real `/v1/audio/transcriptions` call, since whisper-class
 * servers often serve it without `/v1/models`. Backs the "Test audio" action on
 * the settings form.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, testRoleConnectionSchema);
  return ok(await testAudio(input, { kind: "dashboard" }));
});
