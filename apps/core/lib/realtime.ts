/**
 * Shared realtime event contract, re-exported at the path this app has always
 * imported it from. The names themselves live in `@assistant-hub-swarm/contracts`:
 * source apps publish the topics they invalidated across the bus, and
 * app-contributed dashboard pages subscribe to the same list.
 */
export { REALTIME_TOPICS, type RealtimeEvent, type RealtimeTopic } from "@assistant-hub-swarm/contracts";
