CREATE TABLE "digest_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digest_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prompt_id" text NOT NULL,
	"send_at" text NOT NULL,
	"recipients" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "digest_schedules" ADD CONSTRAINT "digest_schedules_prompt_id_digest_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."digest_prompts"("id") ON DELETE restrict ON UPDATE no action;