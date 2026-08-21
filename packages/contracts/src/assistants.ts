/**
 * The fixed id both v1-split import scripts fall back to when the v1
 * database has no active personality: the core import creates an assistant
 * under this id (empty persona), and the tg import binds the v1 bot token to
 * it — deterministically, with no coordination between the two scripts.
 * When v1 HAS an active personality, both use its id instead (assistants
 * are id-preserving conversions of personalities).
 */
export const DEFAULT_ASSISTANT_ID = "assistant-default";
