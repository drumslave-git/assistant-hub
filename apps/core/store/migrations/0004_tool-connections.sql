CREATE TABLE "assistant_tool_connections" (
	"assistant_id" text NOT NULL,
	"connection_id" text NOT NULL,
	CONSTRAINT "assistant_tool_connections_connection_id_assistant_id_pk" PRIMARY KEY("connection_id","assistant_id")
);
--> statement-breakpoint
CREATE TABLE "tool_connection_tools" (
	"connection_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"input_schema" jsonb NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_connection_tools_connection_id_name_pk" PRIMARY KEY("connection_id","name")
);
--> statement-breakpoint
CREATE TABLE "tool_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"transport" text DEFAULT 'http' NOT NULL,
	"endpoint_url" text NOT NULL,
	"auth_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"app_scope" text,
	"all_assistants" boolean DEFAULT true NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"last_discovered_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_connections_transport_check" CHECK ("tool_connections"."transport" in ('http', 'stdio'))
);
--> statement-breakpoint
ALTER TABLE "assistant_tool_connections" ADD CONSTRAINT "assistant_tool_connections_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_tool_connections" ADD CONSTRAINT "assistant_tool_connections_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_connection_tools" ADD CONSTRAINT "tool_connection_tools_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_connections_slug_idx" ON "tool_connections" USING btree ("slug");