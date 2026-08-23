ALTER TABLE "tasks" ADD COLUMN "created_by_owner" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Backfill: tasks created in chat by the then-configured owner keep their
-- owner rights. One-time stamp from the settings row's (now display-only)
-- owner id — after this, the flag is only ever set at creation time from the
-- inbound event's sender.isOwner.
UPDATE "tasks" SET "created_by_owner" = true
WHERE "created_by_user_id" IS NOT NULL
  AND "created_by_user_id" = (SELECT "owner_user_id" FROM "settings" LIMIT 1);
