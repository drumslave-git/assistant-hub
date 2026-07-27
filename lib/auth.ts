/**
 * Client-safe auth constants. The name lives here (not in `server/auth`) so the
 * proxy — which must stay free of server-only modules — and any client code can
 * read it without pulling in crypto or the DB.
 */

/** The operator session cookie. Value format/verification: `server/auth/session.ts`. */
export const SESSION_COOKIE = "op_session";

/** Minimum operator password length, shared by the server checks and form hints. */
export const MIN_PASSWORD_LENGTH = 8;
