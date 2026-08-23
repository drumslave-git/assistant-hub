CREATE TABLE "turn_actions" (
	"correlation_id" text PRIMARY KEY NOT NULL,
	"acted_at" timestamp with time zone DEFAULT now() NOT NULL
);
