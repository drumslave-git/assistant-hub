ALTER TABLE "settings" ADD COLUMN "llm_backend" text DEFAULT 'openai-compatible' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "embedding_backend" text DEFAULT 'openai-compatible' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "image_backend" text DEFAULT 'openai-compatible' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "speech_backend" text DEFAULT 'openai-compatible' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "transcription_backend" text DEFAULT 'openai-compatible' NOT NULL;