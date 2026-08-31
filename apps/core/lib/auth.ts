/**
 * Client-safe auth constants. The name lives here (not in `server/auth`) so the
 * proxy — which must stay free of server-only modules — and any client code can
 * read it without pulling in crypto or the DB.
 */

/** The account session cookie. Value format/verification: `server/auth/session.ts`. */
export const SESSION_COOKIE = "op_session";

/** Minimum account password length, shared by the server checks and form hints. */
export const MIN_PASSWORD_LENGTH = 8;

/** Minimum username length, shared by the server checks and form hints. */
export const MIN_USERNAME_LENGTH = 3;

/** What a username may look like (letters, digits, dot, dash, underscore). */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
