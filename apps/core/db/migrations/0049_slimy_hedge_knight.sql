CREATE TABLE "backends" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text,
	"type" text DEFAULT 'openai-compatible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "chat_backend_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "embedding_backend_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "image_backend_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "speech_backend_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "audio_backend_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "audio_model" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "vision_backend_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "vision_model" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "browser_backend_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "browser_model" text;--> statement-breakpoint
CREATE INDEX "backends_name_idx" ON "backends" USING btree ("name");--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_chat_backend_id_backends_id_fk" FOREIGN KEY ("chat_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_embedding_backend_id_backends_id_fk" FOREIGN KEY ("embedding_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_image_backend_id_backends_id_fk" FOREIGN KEY ("image_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_speech_backend_id_backends_id_fk" FOREIGN KEY ("speech_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_audio_backend_id_backends_id_fk" FOREIGN KEY ("audio_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_vision_backend_id_backends_id_fk" FOREIGN KEY ("vision_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_browser_backend_id_backends_id_fk" FOREIGN KEY ("browser_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "backends" ("id", "name", "base_url", "api_key", "type")
SELECT gen_random_uuid()::text, 'Main', s."llm_base_url", s."llm_api_key", s."llm_backend"
FROM "settings" s
WHERE s."llm_base_url" IS NOT NULL;--> statement-breakpoint
INSERT INTO "backends" ("id", "name", "base_url", "api_key", "type")
SELECT gen_random_uuid()::text, 'Embeddings', s."embedding_base_url", s."embedding_api_key", s."embedding_backend"
FROM "settings" s
WHERE s."embedding_base_url" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "backends" b
    WHERE b."base_url" = s."embedding_base_url" AND b."api_key" IS NOT DISTINCT FROM s."embedding_api_key"
  );--> statement-breakpoint
INSERT INTO "backends" ("id", "name", "base_url", "api_key", "type")
SELECT gen_random_uuid()::text, 'Images', s."image_base_url", s."image_api_key", s."image_backend"
FROM "settings" s
WHERE s."image_base_url" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "backends" b
    WHERE b."base_url" = s."image_base_url" AND b."api_key" IS NOT DISTINCT FROM s."image_api_key"
  );--> statement-breakpoint
INSERT INTO "backends" ("id", "name", "base_url", "api_key", "type")
SELECT gen_random_uuid()::text, 'Speech', s."speech_base_url", s."speech_api_key", s."speech_backend"
FROM "settings" s
WHERE s."speech_base_url" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "backends" b
    WHERE b."base_url" = s."speech_base_url" AND b."api_key" IS NOT DISTINCT FROM s."speech_api_key"
  );--> statement-breakpoint
INSERT INTO "backends" ("id", "name", "base_url", "api_key", "type")
SELECT gen_random_uuid()::text, 'Transcription', s."transcription_base_url", s."transcription_api_key", s."transcription_backend"
FROM "settings" s
WHERE s."transcription_base_url" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "backends" b
    WHERE b."base_url" = s."transcription_base_url" AND b."api_key" IS NOT DISTINCT FROM s."transcription_api_key"
  );--> statement-breakpoint
UPDATE "settings" s SET "chat_backend_id" = (
  SELECT b."id" FROM "backends" b
  WHERE b."base_url" = s."llm_base_url" AND b."api_key" IS NOT DISTINCT FROM s."llm_api_key"
  LIMIT 1
) WHERE s."llm_base_url" IS NOT NULL;--> statement-breakpoint
UPDATE "settings" s SET "embedding_backend_id" = (
  SELECT b."id" FROM "backends" b
  WHERE b."base_url" = s."embedding_base_url" AND b."api_key" IS NOT DISTINCT FROM s."embedding_api_key"
  LIMIT 1
) WHERE s."embedding_base_url" IS NOT NULL;--> statement-breakpoint
UPDATE "settings" s SET "image_backend_id" = (
  SELECT b."id" FROM "backends" b
  WHERE b."base_url" = s."image_base_url" AND b."api_key" IS NOT DISTINCT FROM s."image_api_key"
  LIMIT 1
) WHERE s."image_base_url" IS NOT NULL;--> statement-breakpoint
UPDATE "settings" s SET "speech_backend_id" = (
  SELECT b."id" FROM "backends" b
  WHERE b."base_url" = s."speech_base_url" AND b."api_key" IS NOT DISTINCT FROM s."speech_api_key"
  LIMIT 1
) WHERE s."speech_base_url" IS NOT NULL;--> statement-breakpoint
UPDATE "settings" s SET "audio_backend_id" = (
  SELECT b."id" FROM "backends" b
  WHERE b."base_url" = s."transcription_base_url" AND b."api_key" IS NOT DISTINCT FROM s."transcription_api_key"
  LIMIT 1
) WHERE s."transcription_base_url" IS NOT NULL;--> statement-breakpoint
UPDATE "settings" SET "audio_model" = "transcription_model" WHERE "transcription_model" IS NOT NULL;
