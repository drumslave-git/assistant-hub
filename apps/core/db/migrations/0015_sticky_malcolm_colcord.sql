ALTER TABLE "settings" ADD COLUMN "daily_jobs_run_time" text DEFAULT '04:00' NOT NULL;--> statement-breakpoint
-- Carry the operator's existing choice over rather than resetting them to the
-- default: the per-job run times are collapsing into this one, and the
-- self-improvement time is the one they actually configured (history
-- summarization shipped in the same session and was never separately tuned).
-- Hand-added — drizzle-kit generates DDL, not data migration.
UPDATE "settings" SET "daily_jobs_run_time" = "self_improvement_run_time";