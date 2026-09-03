/**
 * The wire contract's major version — the one number a transport and a core
 * must agree on. It is bumped when an event, an internal route or the
 * registration shape changes incompatibly; a transport announces the major
 * it was built against at registration, and a core that speaks another
 * refuses it with a reason the dashboard shows (user decision, 2026-09-02:
 * a mismatch is never a silent drop).
 *
 * 2 (2026-09-03): every platform id on the wire is a string. The turn binding
 * a tool call carries (`threadId`, `replyToSourceMessageId`) and the delivery
 * a tool reports back (`sourceMessageId`) were numbers, which a 64-bit
 * snowflake does not survive.
 */
export const CONTRACT_MAJOR = 2;
