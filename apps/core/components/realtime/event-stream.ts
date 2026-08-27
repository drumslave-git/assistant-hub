/**
 * The tab's single realtime connection, re-exported at the path this app has
 * always imported it from. It lives in `@assistant-hub/ui` so an
 * app-contributed page shares the same one connection (see the module note
 * there for why one per tab is not optional).
 */
export { subscribeToRealtime, type RealtimeSubscriber } from "@assistant-hub/ui";
