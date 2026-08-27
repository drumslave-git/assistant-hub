/**
 * The shared realtime subscription hook, re-exported at the path this app has
 * always imported it from. It lives in `@assistant-hub/ui` so app-contributed
 * pages stay live the same way the shell's own do.
 */
export { useLiveEvent } from "@assistant-hub/ui";
