CREATE TABLE "memory_extraction_days" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "memory_extraction_days_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chat_id" text NOT NULL,
	"extraction_date" text NOT NULL,
	"message_count" integer NOT NULL,
	"note_count" integer NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_days_chat_date_idx" ON "memory_extraction_days" USING btree ("chat_id","extraction_date");