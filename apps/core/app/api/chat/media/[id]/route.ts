import { ApiError } from "@/lib/api-error";
import { requireOperator } from "@/server/auth/service";
import { chatMediaBytes } from "@/server/source/chat-operator";

/**
 * The bytes of one web-chat image, for the thread view to render. Not a JSON
 * route: it answers the image itself, so it authenticates the operator by
 * hand and streams what the source holds. A described image still has its
 * bytes in the chat store — a web thread is the only archive its pictures
 * have (see `apps/chat/src/media.ts`).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireOperator(request);
    const { id } = await context.params;
    const image = await chatMediaBytes(id);
    if (!image) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        "content-type": image.mimeType,
        // The bytes of a media row never change once stored.
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    const apiError = err instanceof ApiError ? err : ApiError.internal("media read failed");
    return new Response(apiError.message, { status: apiError.status });
  }
}
