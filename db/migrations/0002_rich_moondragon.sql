CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "social" jsonb;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "registry" jsonb;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "web_locations" jsonb;