import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/auth";

/**
 * Optimistic auth redirect at the network boundary (Next 16 Proxy — the
 * renamed middleware file convention), per the Next.js authentication guide:
 * the proxy checks only that a session cookie is *present* and redirects bare
 * browsers to `/login`; verifying the cookie's signature needs the DB-stored
 * secret, and that real check runs where the database belongs — the dashboard
 * route group's layout for pages, `defineRoute` for every API. A forged cookie
 * therefore passes this file and is rejected one step later.
 *
 * API routes are excluded here (they answer 401 JSON, not a redirect), as are
 * the login/setup pages and static assets.
 */
export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const login = new URL("/login", request.url);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    // Everything except: API routes, Next internals/static assets, favicon,
    // and the two public auth pages.
    "/((?!api|_next/static|_next/image|favicon\\.ico|login|setup).*)",
  ],
};
