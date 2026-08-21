CREATE TABLE "bot_reactions" (
	"chat_id" text NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"emoji" text NOT NULL,
	"reacted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_reactions_chat_id_telegram_message_id_pk" PRIMARY KEY("chat_id","telegram_message_id")
);
--> statement-breakpoint
ALTER TABLE "bot_reactions" ADD CONSTRAINT "bot_reactions_message_fk" FOREIGN KEY ("chat_id","telegram_message_id") REFERENCES "public"."chat_messages"("chat_id","telegram_message_id") ON DELETE cascade ON UPDATE no action;