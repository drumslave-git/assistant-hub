/**
 * How app-contributed dashboard UI talks to its own app: through the shell's
 * proxy (`/api/<app>/…`), which owns the operator session, and through the
 * shell's one response envelope — `{ data }` on success, `{ error: { message } }`
 * on failure. Extensions never see another app's API and never invent a second
 * error shape.
 */

export interface ApiOkBody<T> {
  data?: T;
}

export interface ApiErrorBody {
  error?: { message?: string };
}

/** The server's message for a failed response, or a legible fallback. */
export async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/**
 * One proxy call: returns the envelope's `data`, or throws an Error carrying
 * the server's own message — so a source app's verdict ("this thread is
 * gone") reaches the operator verbatim instead of as a status code.
 */
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(await readApiError(res));
  const body = (await res.json()) as ApiOkBody<T>;
  return body.data as T;
}
