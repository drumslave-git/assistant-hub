-- Put historical scheduled-task fire traces on the app-wide
-- `<chatId>:<messageId>` correlation convention.
--
-- A fire has no incoming message to key on, so it used to settle keeping the
-- task id it opened with. That left the trace unreachable from the message it
-- delivered (feedback on a fired message could not find the prompt behind it)
-- and invisible to the chat-scoped trace queries, which match
-- `correlation_id LIKE '<chatId>:%'`. `fire.ts` now settles with the delivered
-- correlation; this carries the traces already recorded over to it.
--
-- The chat is the fire trace's `trigger_actor` (set to `task.chatId`) and the
-- delivered id is on its `output` event. The task stays linked via `related_ids`.
-- Only a successful fire delivered a message, so only those have one to key on.
UPDATE "traces" AS t
SET "correlation_id" = t."trigger_actor" || ':' || (e."data" ->> 'messageId')
FROM "trace_events" AS e
WHERE e."trace_id" = t."id"
  AND t."feature" = 'scheduled-tasks'
  AND t."action" = 'fire'
  AND t."status" = 'success'
  AND t."trigger_actor" IS NOT NULL
  AND e."type" = 'output'
  AND e."data" ? 'messageId'
  AND jsonb_typeof(e."data" -> 'messageId') = 'number';
