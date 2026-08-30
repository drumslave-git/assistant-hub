import { z } from "zod";

import { defineRoute, ok, parseJson } from "@/server/http";
import { postChatMessage } from "@/features/web-chat/server/service";

/**
 * Saying something in a thread. The route does not run the turn: the service
 * stores the message and enqueues it, and the answer arrives the same way
 * every other source's does — through the pipeline and back over the bus.
 */

/**
 * Text, an image, or both. The image arrives base64 from the browser and is
 * capped here: the service normalizes it down to a bounded JPEG, but the
 * route should refuse an upload nobody could want before it is buffered.
 */
const MAX_IMAGE_BASE64 = 16 * 1024 * 1024;

const postSchema = z
  .object({
    text: z.string().trim().max(10_000).default(""),
    image: z
      .object({
        dataBase64: z.string().min(1).max(MAX_IMAGE_BASE64),
        mimeType: z.string().max(200).nullable().optional(),
      })
      .optional(),
    audio: z
      .object({
        dataBase64: z.string().min(1).max(MAX_IMAGE_BASE64),
        mimeType: z.string().max(200).nullable().optional(),
      })
      .optional(),
  })
  .refine(
    (value) => value.text.length > 0 || value.image !== undefined || value.audio !== undefined,
    { message: "a message needs text, an image, a voice note, or some of each" },
  );

export const POST = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, postSchema);
  return ok(await postChatMessage(params.id, input));
});
