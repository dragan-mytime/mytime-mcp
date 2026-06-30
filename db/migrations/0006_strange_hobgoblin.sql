CREATE TABLE "social_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"social_account_id" uuid NOT NULL,
	"external_post_id" text NOT NULL,
	"captured_date" date NOT NULL,
	"posted_at" timestamp with time zone,
	"post_type" text,
	"caption" text,
	"permalink" text,
	"media_url" text,
	"media_urls" jsonb,
	"likes" integer,
	"comments" integer,
	"shares" integer,
	"views" integer,
	"engagement" integer,
	"estimated_reach" integer,
	"reach_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "social_posts_account_external_uq" ON "social_posts" USING btree ("social_account_id","external_post_id");--> statement-breakpoint
CREATE INDEX "social_posts_account_posted_idx" ON "social_posts" USING btree ("social_account_id","posted_at");