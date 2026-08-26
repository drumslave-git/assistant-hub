import { createPersonLinkSchema } from "@/features/person-links/server/schema";
import { createLink, getPersonLinks } from "@/features/person-links/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Person-links collection API. Thin handlers: the service owns validation,
 * the one-link-per-identity conflict, persistence, and trace recording.
 */
export const GET = defineRoute(async () => ok({ links: await getPersonLinks() }));

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createPersonLinkSchema);
  return ok(await createLink(input, { kind: "dashboard" }), { status: 201 });
});
