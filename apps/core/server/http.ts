import "server-only";

import { z, type ZodType } from "zod";

import { ApiError, isApiError, type ApiErrorBody, type ApiOkBody } from "@/lib/api-error";

/**
 * Shared Route Handler infrastructure.
 *
 * Route Handlers must stay thin: they declare input/output schemas and a body,
 * and delegate validation, error mapping, and JSON serialization here. This
 * keeps error shapes, status codes, and response envelopes identical across
 * every feature.
 */

/**
 * Standard success envelope. Re-exported so Route Handlers keep importing their
 * response contract from one place; it is defined in `lib/api-error` so client
 * code can read it without reaching through this server-only module.
 */
export type { ApiOkBody };

/** JSON response for a successful result. */
export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data } satisfies ApiOkBody<T>, {
    status: 200,
    ...init,
  });
}

/** JSON response for a failed result, using the shared error envelope. */
export function errorResponse(error: ApiError): Response {
  return Response.json(error.toBody() satisfies ApiErrorBody, {
    status: error.status,
  });
}

/**
 * Pretty-printed JSON file download (`Content-Disposition: attachment`). Shared
 * by every feature's Debug page for log/trace bundle export, so the download
 * shape stays consistent. Not wrapped in the `data` envelope — the body is the
 * file itself.
 */
export function jsonDownload(data: unknown, filename: string): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

/**
 * CSV file download (`Content-Disposition: attachment`). Shared so every feature
 * that exports tabular data emits the same headers. A UTF-8 BOM is prepended so
 * Excel opens non-ASCII content correctly; the shared CSV parser strips it again
 * on import, so an export still round-trips.
 */
export function csvDownload(csv: string, filename: string): Response {
  return new Response("\uFEFF" + csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** Map any thrown value to an {@link ApiError} without leaking internals. */
export function toApiError(err: unknown): ApiError {
  if (isApiError(err)) return err;
  if (err instanceof z.ZodError) {
    return new ApiError("validation_error", "Request validation failed", {
      details: z.flattenError(err),
      cause: err,
    });
  }
  return ApiError.internal("Internal server error", { cause: err });
}

/** Read a JSON request body, throwing `bad_request` on invalid JSON. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw ApiError.badRequest("Request body must be valid JSON");
  }
}

/** Parse and validate a JSON request body, throwing `bad_request` on invalid JSON. */
export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  return schema.parse(await readJsonBody(request));
}

/** Validate URL search params against a schema. */
export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  return schema.parse(params);
}

/**
 * Context passed to a route body. `params` are the (already-awaited) dynamic
 * route params; the wrapper resolves the Next promise so handlers don't repeat
 * the boilerplate.
 */
export interface RouteBodyContext {
  request: Request;
  params: Record<string, string>;
}

export type RouteBody = (ctx: RouteBodyContext) => Promise<Response> | Response;

/** Next.js passes params as a promise in the second argument. */
interface NextRouteContext {
  params?: Promise<Record<string, string>>;
}

export interface DefineRouteOptions {
  /**
   * Whether the route requires a valid operator session (the default). The only
   * public routes are the auth endpoints themselves and the health probe — set
   * `auth: false` explicitly there, nowhere else. Enforced here as well as at
   * the proxy layer so the API stays covered even when the proxy is bypassed.
   */
  auth?: boolean;
}

/**
 * Wrap a route body with the operator-session check and shared error handling.
 * Any thrown value — `ApiError`, `ZodError`, or unknown — becomes a consistent
 * JSON error response with the correct status.
 *
 * ```ts
 * export const GET = defineRoute(async ({ params }) => ok(await load(params.id)));
 * ```
 */
export function defineRoute(body: RouteBody, options: DefineRouteOptions = {}) {
  return async function handler(
    request: Request,
    context?: NextRouteContext,
  ): Promise<Response> {
    try {
      if (options.auth !== false) {
        // Imported lazily to keep the http module free of a DB dependency for
        // its pure helpers (and their unit tests).
        const { requireOperator } = await import("@/server/auth/service");
        await requireOperator(request);
      }
      const params = (await context?.params) ?? {};
      return await body({ request, params });
    } catch (err) {
      const apiError = toApiError(err);
      // Expected failures travel as ApiError/ZodError; anything else is a bug the
      // operator can only diagnose from the server log — the JSON body says
      // "internal error" and no trace covers a throw before a service opens one.
      if (apiError.code === "internal_error") {
        console.error(`Unhandled error in ${new URL(request.url).pathname}:`, err);
      }
      return errorResponse(apiError);
    }
  };
}
