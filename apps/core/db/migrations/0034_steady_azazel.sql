CREATE TABLE "media_blobs" (
	"media_id" text NOT NULL,
	"frame_index" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "media_blobs_media_id_frame_index_pk" PRIMARY KEY("media_id","frame_index")
);
--> statement-breakpoint
ALTER TABLE "media_blobs" ADD CONSTRAINT "media_blobs_media_id_message_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."message_media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Carry existing bytes (only pending rows have any) into the blob table before
-- dropping the base64 columns. A still image becomes frame 0; a video's frames
-- become rows 0..n-1 in order — its data_base64 was always frames[0], so it is
-- not copied separately.
INSERT INTO "media_blobs" ("media_id", "frame_index", "data")
SELECT "id", 0, decode("data_base64", 'base64')
FROM "message_media"
WHERE "data_base64" IS NOT NULL
  AND ("frames_base64" IS NULL OR jsonb_array_length("frames_base64") = 0);--> statement-breakpoint
INSERT INTO "media_blobs" ("media_id", "frame_index", "data")
SELECT m."id", f.ord - 1, decode(f.val, 'base64')
FROM "message_media" m,
  jsonb_array_elements_text(m."frames_base64") WITH ORDINALITY AS f(val, ord)
WHERE m."frames_base64" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "message_media" DROP COLUMN "data_base64";--> statement-breakpoint
ALTER TABLE "message_media" DROP COLUMN "frames_base64";