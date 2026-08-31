ALTER TABLE "tool_connections" ADD COLUMN "owner_account_id" text;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Operator-created connections belong to the first admin; managed rows are
-- the hub's own and stay unowned.
UPDATE "tool_connections" SET "owner_account_id" = (SELECT "id" FROM "accounts" WHERE "role" = 'admin' AND "active" ORDER BY "created_at" LIMIT 1) WHERE "managed" = false AND "owner_account_id" IS NULL;
