import { testAudioConnectionSchema } from "@/features/settings/server/schema";
import { testAudio } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Probe the audio (STT) role by transcribing a fraction of a second of
 * generated silence — a real call in the configured transcription mode
 * (`/v1/audio/transcriptions`, or an `input_audio` chat completion), since
 * neither a model listing nor anything cheaper can prove audio works. Backs
 * the "Test audio" action on the settings form.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, testAudioConnectionSchema);
  return ok(await testAudio(input, { kind: "dashboard" }));
});
