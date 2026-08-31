-- Phase 8 slice E: the account IS the web-chat identity. web_users dies;
-- threads key on the account id; the operator row's threads, curated fields
-- and every chat:user:<operatorWebId> ref move onto the first admin BEFORE
-- the table drops, so nothing dangles.
ALTER TABLE "accounts" ADD COLUMN "language" text;--> statement-breakpoint
-- The operator web user's curated fields land on the first admin (only
-- where the admin has nothing of its own yet).
UPDATE "accounts" a
SET "display_name" = COALESCE(a."display_name", op."name"),
    "aliases" = CASE WHEN cardinality(a."aliases") = 0 THEN op."aliases" ELSE a."aliases" END,
    "language" = COALESCE(a."language", op."language")
FROM (SELECT "name", "aliases", "language" FROM "web_users" WHERE "is_operator" LIMIT 1) op
WHERE a."id" = (SELECT "id" FROM "accounts" WHERE "role" = 'admin' AND "active" ORDER BY "created_at" LIMIT 1);--> statement-breakpoint
ALTER TABLE "web_threads" DROP CONSTRAINT "web_threads_user_id_web_users_id_fk";
--> statement-breakpoint
-- Every existing thread belonged to the single operator: repoint them all
-- at the first admin account.
UPDATE "web_threads"
SET "user_id" = (SELECT "id" FROM "accounts" WHERE "role" = 'admin' AND "active" ORDER BY "created_at" LIMIT 1)
WHERE "user_id" IN (SELECT "id" FROM "web_users");--> statement-breakpoint
-- Rewrite the operator web user's scoped ref (chat:user:<oldId>) to the
-- admin account's ref wherever refs are stored.
UPDATE "user_memories" SET "user_ref" = 'chat:user:' || (SELECT "id" FROM "accounts" WHERE "role" = 'admin' AND "active" ORDER BY "created_at" LIMIT 1)
WHERE "user_ref" IN (SELECT 'chat:user:' || "id" FROM "web_users")
  AND NOT EXISTS (SELECT 1 FROM "user_memories" m2 WHERE m2."user_ref" = 'chat:user:' || (SELECT "id" FROM "accounts" WHERE "role" = 'admin' AND "active" ORDER BY "created_at" LIMIT 1));--> statement-breakpoint
UPDATE "memory_entries" SET "user_ref" = 'chat:user:' || (SELECT "id" FROM "accounts" WHERE "role" = 'admin' AND "active" ORDER BY "created_at" LIMIT 1)
WHERE "user_ref" IN (SELECT 'chat:user:' || "id" FROM "web_users");--> statement-breakpoint
UPDATE "communication_preferences" SET "user_ref" = 'chat:user:' || (SELECT "id" FROM "accounts" WHERE "role" = 'admin' AND "active" ORDER BY "created_at" LIMIT 1)
WHERE "user_ref" IN (SELECT 'chat:user:' || "id" FROM "web_users");--> statement-breakpoint
UPDATE "person_link_members" SET "user_ref" = 'chat:user:' || (SELECT "id" FROM "accounts" WHERE "role" = 'admin' AND "active" ORDER BY "created_at" LIMIT 1)
WHERE "user_ref" IN (SELECT 'chat:user:' || "id" FROM "web_users")
  AND NOT EXISTS (
    SELECT 1 FROM "person_link_members" p2
    WHERE p2."link_id" = "person_link_members"."link_id"
      AND p2."user_ref" = 'chat:user:' || (SELECT "id" FROM "accounts" WHERE "role" = 'admin' AND "active" ORDER BY "created_at" LIMIT 1));--> statement-breakpoint
UPDATE "tasks" SET "created_by_user_ref" = 'chat:user:' || (SELECT "id" FROM "accounts" WHERE "role" = 'admin' AND "active" ORDER BY "created_at" LIMIT 1)
WHERE "created_by_user_ref" IN (SELECT 'chat:user:' || "id" FROM "web_users");--> statement-breakpoint
UPDATE "addressing_exclusions" SET "user_ref" = 'chat:user:' || (SELECT "id" FROM "accounts" WHERE "role" = 'admin' AND "active" ORDER BY "created_at" LIMIT 1)
WHERE "user_ref" IN (SELECT 'chat:user:' || "id" FROM "web_users");--> statement-breakpoint
ALTER TABLE "web_users" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "web_users" CASCADE;--> statement-breakpoint
ALTER TABLE "web_threads" ADD CONSTRAINT "web_threads_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
