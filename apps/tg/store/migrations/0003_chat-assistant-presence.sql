CREATE TABLE "chat_assistants" (
	"chat_id" text NOT NULL,
	"assistant_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_assistants_chat_id_assistant_id_pk" PRIMARY KEY("chat_id","assistant_id")
);
--> statement-breakpoint
ALTER TABLE "chat_assistants" ADD CONSTRAINT "chat_assistants_chat_id_chats_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_assistants_chat_idx" ON "chat_assistants" USING btree ("chat_id");