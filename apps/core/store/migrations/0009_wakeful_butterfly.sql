ALTER TABLE "assistants" ADD COLUMN "owner_account_id" text;--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Existing assistants (created under the single-operator model) belong to
-- the first admin - the ported operator.
UPDATE "assistants" SET "owner_account_id" = (SELECT "id" FROM "accounts" WHERE "role" = 'admin' AND "active" ORDER BY "created_at" LIMIT 1) WHERE "owner_account_id" IS NULL;
