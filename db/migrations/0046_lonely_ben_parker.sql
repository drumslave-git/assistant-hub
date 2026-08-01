ALTER TABLE "browser_agent_runs" ADD COLUMN "restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_agent_runs" ADD COLUMN "source_urls" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "browser_download_max_mb";