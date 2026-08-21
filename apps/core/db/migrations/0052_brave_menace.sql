ALTER TABLE "settings" ADD COLUMN "classifier_backend_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "classifier_model" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "background_backend_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "background_model" text;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_classifier_backend_id_backends_id_fk" FOREIGN KEY ("classifier_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_background_backend_id_backends_id_fk" FOREIGN KEY ("background_backend_id") REFERENCES "public"."backends"("id") ON DELETE restrict ON UPDATE no action;