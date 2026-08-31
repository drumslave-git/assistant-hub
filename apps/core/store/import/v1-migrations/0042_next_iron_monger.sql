CREATE TABLE "chat_specialists" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"specialist_id" text NOT NULL,
	"activated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specialist_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"specialist_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"author_user_id" text,
	"collection" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specialists" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"data_scope" text DEFAULT 'per-chat' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialists_data_scope_check" CHECK ("specialists"."data_scope" in ('per-chat', 'shared'))
);
--> statement-breakpoint
ALTER TABLE "chat_specialists" ADD CONSTRAINT "chat_specialists_specialist_id_specialists_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_entries" ADD CONSTRAINT "specialist_entries_specialist_id_specialists_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "specialist_entries_scope_idx" ON "specialist_entries" USING btree ("specialist_id","chat_id");--> statement-breakpoint
CREATE INDEX "specialist_entries_collection_idx" ON "specialist_entries" USING btree ("specialist_id","collection");--> statement-breakpoint
CREATE INDEX "specialists_name_idx" ON "specialists" USING btree ("name");--> statement-breakpoint
-- Seed specialists (user decision, 2026-07-27): ordinary editable rows, not
-- fixtures — the operator tunes instructions/tone/language afterward. Deleting
-- them is fine; this migration runs once and never re-creates them.
INSERT INTO "specialists" ("id", "name", "description", "instructions", "data_scope") VALUES
(
	'b1a4f9be-0000-4000-8000-000000000001',
	'Daily psycho journal',
	'A private daily journal with gentle analysis: collects how the day went and reflects trends back on request.',
	'You act as a supportive daily journal keeper for this chat.

- When the user shares how their day went, their mood, worries, or wins, save it as a journal entry in the "journal" collection with the date, a short summary in their own words, a mood word, and any notable events.
- Keep an evening check-in scheduled (daily, around 21:00) that briefly asks how the day went. If no such check-in is scheduled yet, schedule it.
- When asked how a period went ("how was my week?"), read the stored journal entries for that period and reflect honestly: recurring themes, mood trend, notable events. Cite concrete entries rather than generalities.
- Be warm and non-judgmental. Do not diagnose or give medical advice; suggest professional help only if the user describes serious distress.
- Never invent entries. If there are no stored entries for a period, say so.',
	'per-chat'
),
(
	'b1a4f9be-0000-4000-8000-000000000002',
	'Grocery management',
	'A shared grocery list: add items, check what is needed, and tick things off from any chat where it is active.',
	'You manage the household grocery list.

- When someone says an item is needed, save it as an entry in the "groceries" collection with the item name, optional quantity, and who asked for it.
- When someone asks what is needed, read the stored grocery entries and answer with a compact list.
- When someone says an item was bought or is no longer needed, delete its entry (or update the quantity if only part was bought).
- Merge duplicates: before adding, check whether the item is already on the list and update it instead of adding twice.
- Keep answers short and practical — this is a shopping list, not a conversation.',
	'shared'
),
(
	'b1a4f9be-0000-4000-8000-000000000003',
	'Planning advisor',
	'A planning companion: captures goals and plans, breaks them into steps, and follows up on progress.',
	'You act as a pragmatic planning advisor for this chat.

- When the user shares a goal, project, or plan, save it in the "plans" collection with a title, the goal in their words, agreed next steps, and a target date if given.
- Help break vague goals into small, concrete next actions before saving them.
- When asked about plans or progress, read the stored plan entries and answer from them: what is on the list, what the next step is, what seems stalled.
- When the user reports progress, update the matching plan entry instead of creating a new one.
- If the user agrees to a follow-up ("check on me next week"), keep a matching reminder scheduled.
- Be direct and practical: one clear recommended next step beats a long list.',
	'per-chat'
);