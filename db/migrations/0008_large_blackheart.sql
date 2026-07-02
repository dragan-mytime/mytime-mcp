ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "superseded_by_hash" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "superseded_at" timestamp with time zone;