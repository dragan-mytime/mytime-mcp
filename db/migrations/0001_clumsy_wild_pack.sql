CREATE TABLE "ad_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" text NOT NULL,
	"ad_archive_id" text NOT NULL,
	"captured_date" date NOT NULL,
	"started_running_date" date,
	"days_running" integer,
	"platforms" text[],
	"cta_type" text,
	"link_url" text,
	"ad_title" text,
	"ad_body" text,
	"media_type" text,
	"media_url" text,
	"snapshot_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_observations" ADD CONSTRAINT "ad_observations_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_observations_target_ad_date_uq" ON "ad_observations" USING btree ("target_id","ad_archive_id","captured_date");--> statement-breakpoint
CREATE INDEX "ad_observations_target_date_idx" ON "ad_observations" USING btree ("target_id","captured_date");