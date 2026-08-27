-- Memory is about PEOPLE, not about telegram accounts.
--
-- Both memory tables keyed their person by a foreign key into the telegram
-- directory, which made a fact about anyone the assistant meets elsewhere
-- impossible to store: a web-chat user has no row there and never will.
-- Since Phase 4 the assistant is reachable in more than one app, so the id is
-- a source-local user id from whichever source wrote it, and person links are
-- what tie one human's identities together (they already do the reading).
--
-- Dropping a constraint loses nothing that was true: every existing row still
-- names a telegram user, and `known_users` deletions no longer cascade into
-- memory — which is the safer half of the trade for durable knowledge.

ALTER TABLE "memory_entries" DROP CONSTRAINT "memory_entries_user_id_known_users_user_id_fk";
--> statement-breakpoint
ALTER TABLE "user_memories" DROP CONSTRAINT "user_memories_user_id_known_users_user_id_fk";
