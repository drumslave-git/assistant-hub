/**
 * The operator-timezone provider, re-exported at the path this app has always
 * imported it from. It lives in `@assistant-hub/ui` beside `<Timestamp>`; the
 * root layout reads the zone from the database once per request and seeds it.
 */
export { TimezoneProvider, useTimezone } from "@assistant-hub/ui";
