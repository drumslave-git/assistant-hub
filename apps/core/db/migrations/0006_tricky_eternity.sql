CREATE TABLE "chat_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chat_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chat_id" text NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"role" text NOT NULL,
	"user_id" text,
	"content" text NOT NULL,
	"reply_to_message_id" bigint,
	"sent_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_chat_msg_idx" ON "chat_messages" USING btree ("chat_id","telegram_message_id");--> statement-breakpoint
CREATE INDEX "chat_messages_chat_sent_idx" ON "chat_messages" USING btree ("chat_id","sent_at");