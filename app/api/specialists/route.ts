import { createSpecialistSchema } from "@/features/specialists/server/schema";
import { createSpecialist, getSpecialistsView } from "@/features/specialists/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Specialists collection API. Thin handlers: the service owns validation,
 * persistence, and trace recording.
 */
export const GET = defineRoute(async () => ok(await getSpecialistsView()));

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createSpecialistSchema);
  return ok(await createSpecialist(input, { kind: "dashboard" }), { status: 201 });
});
