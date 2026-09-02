import "server-only";

/**
 * Image normalization, re-exported at the path this feature has always
 * imported it from. The implementation lives in `@assistant-hub-swarm/media`: the
 * core, tg and chat all normalize images for the same vision endpoints, and
 * two byte-identical copies were already one too many.
 */
export { VISION_MAX_DIMENSION, normalizeImageForChat } from "@assistant-hub-swarm/media";
