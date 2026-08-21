import type { RealtimeEvent } from "@/lib/realtime";
import { requireOperator } from "@/server/auth";
import { errorResponse, toApiError } from "@/server/http";
import { subscribe } from "@/server/realtime/hub";

/**
 * Shared realtime stream (Server-Sent Events). One long-lived connection per
 * dashboard tab carries every topic; clients filter by `topic` on the payload.
 * Standard Next.js Route Handler streaming a `ReadableStream` — no custom server,
 * runs under `next start` and the standalone Docker image unchanged.
 */

// Never cache or statically optimize a live stream.
export const dynamic = "force-dynamic";

/** SSE comment heartbeat interval — keeps the connection alive through proxies. */
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
  // Not a defineRoute handler (it streams), so it carries the session check
  // itself. EventSource sends cookies on same-origin requests automatically.
  try {
    await requireOperator(request);
  } catch (err) {
    return errorResponse(toApiError(err));
  }
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      // Open the stream and disable proxy buffering hints via the first comment.
      write(": connected\n\n");

      const unsubscribe = subscribe((event: RealtimeEvent) => {
        write(`data: ${JSON.stringify(event)}\n\n`);
      });

      const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable response buffering on nginx-style proxies so events flush live.
      "X-Accel-Buffering": "no",
    },
  });
}
