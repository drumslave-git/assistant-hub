import { detectBackendSchema } from "@/features/settings/server/schema";
import { detectBackend } from "@/server/llm/backends";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Fingerprint the inference server behind a URL, so the operator does not have
 * to know that Ollama answers on `/api/version` while llama-server answers on
 * `/props`. Backs the "Detect" action beside each backend dropdown.
 *
 * A suggestion, never an authority: the answer is offered to the operator, who
 * remains the one who picks (user decision, 2026-08-07). An unidentifiable
 * endpoint comes back with a null backend rather than an error — nothing about
 * the configuration is wrong just because a server declined to name itself.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, detectBackendSchema);
  return ok(await detectBackend(input.baseUrl));
});
