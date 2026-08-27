import { z } from "zod";

import { defineRoute, ok, parseJson } from "@/server/http";
import { postChatMessage } from "@/server/source/chat-operator";

/**
 * Saying something in a thread. The core does not run the turn here: the
 * chat app stores the message and enqueues it, and the answer arrives the
 * same way every other source's does — through the pipeline and back over
 * the bus.
 */

const postSchema = z.object({ text: z.string().trim().min(1).max(10_000) });

export const POST = defineRoute(async ({ request, params }) => {
  const { text } = await parseJson(request, postSchema);
  return ok(await postChatMessage(params.id, text));
});
