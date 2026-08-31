CREATE TABLE "group_members" (
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_chat_id_user_id_pk" PRIMARY KEY("chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "known_groups" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"title" text,
	"type" text,
	"notes" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_chat_id_known_groups_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."known_groups"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_known_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."known_users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_members_chat_idx" ON "group_members" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "group_members_user_idx" ON "group_members" USING btree ("user_id");