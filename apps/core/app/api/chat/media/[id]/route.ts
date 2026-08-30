import { getMediaById } from "@/features/web-chat/server/media-repository";
import { ApiError } from "@/lib/api-error";
import { requireOperator } from "@/server/auth/service";

/**
 * The bytes of one web-chat image, for the thread view to render. Not a JSON
 * route: it answers the image itself, so it authenticates the operator by
 * hand and streams what the store holds. A described image still has its
 * bytes — a web thread is the only archive its pictures have (see
 * `features/web-chat/server/media-repository.ts`).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireOperator(request);
    const { id } = await context.params;
    const media = await getMediaById(id);
    const frame = media?.frames[0];
    if (!media || !frame) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(Buffer.from(frame, "base64")), {
      headers: {
        "content-type": media.mimeType ?? "image/jpeg",
        // The bytes of a media row never change once stored.
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    const apiError = err instanceof ApiError ? err : ApiError.internal("media read failed");
    return new Response(apiError.message, { status: apiError.status });
  }
}
