ALTER TABLE "chat_messages" ADD COLUMN "processed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Orphan sweep before the FK lands. Media rows must belong to a mirrored chat
-- message; historical orphans exist (bot-authored media that was ingested but
-- never mirrored, and past best-effort mirror failures).
-- Described orphans carry transcripts/descriptions worth keeping reachable, so
-- they get a stub mirror row (empty content — the media annotation is the body).
INSERT INTO "chat_messages" ("chat_id", "telegram_message_id", "role", "user_id", "content", "sent_at")
SELECT mm."chat_id", mm."telegram_message_id", 'user', NULL, '', mm."created_at"
FROM "message_media" mm
LEFT JOIN "chat_messages" cm
  ON cm."chat_id" = mm."chat_id" AND cm."telegram_message_id" = mm."telegram_message_id"
WHERE cm."id" IS NULL AND mm."status" = 'described';--> statement-breakpoint
-- Pending/unavailable orphans hold no described text; their blobs cascade away.
DELETE FROM "message_media" mm
WHERE mm."status" <> 'described'
  AND NOT EXISTS (
    SELECT 1 FROM "chat_messages" cm
    WHERE cm."chat_id" = mm."chat_id" AND cm."telegram_message_id" = mm."telegram_message_id"
  );--> statement-breakpoint
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_message_fk" FOREIGN KEY ("chat_id","telegram_message_id") REFERENCES "public"."chat_messages"("chat_id","telegram_message_id") ON DELETE cascade ON UPDATE no action;
