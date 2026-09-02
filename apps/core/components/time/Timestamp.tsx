/**
 * The shared `<Timestamp>`, re-exported at the path this app has always
 * imported it from. It lives in `@assistant-hub-swarm/ui` so app-contributed
 * dashboard UI renders instants exactly the way the shell does — one
 * component, one timezone rule (see `packages/ui/src/Timestamp.tsx`).
 */
export { Timestamp } from "@assistant-hub-swarm/ui";
