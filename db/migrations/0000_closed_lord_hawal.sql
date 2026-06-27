CREATE TYPE "public"."qty_basis" AS ENUM('exact', 'assumed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'analyst', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."social_platform" AS ENUM('instagram', 'facebook', 'tiktok');--> statement-breakpoint
CREATE TYPE "public"."stock_status" AS ENUM('in_stock', 'low_stock', 'out_of_stock', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."web_source" AS ENUM('apify', 'firecrawl', 'xml_feed');--> statement-breakpoint
CREATE TABLE "authorized_users" (
	"email" text PRIMARY KEY NOT NULL,
	"role" "role" DEFAULT 'viewer' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_date" date NOT NULL,
	"collector" text NOT NULL,
	"target_id" text,
	"status" text NOT NULL,
	"rows_written" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inventory_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"captured_date" date NOT NULL,
	"stock_status" "stock_status" NOT NULL,
	"stock_quantity" integer,
	"qty_basis" "qty_basis" DEFAULT 'unknown' NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_online" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"captured_date" date NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"sale_price" numeric(12, 2),
	"currency" text DEFAULT 'MKD' NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"category" text,
	"url" text,
	"image_url" text,
	"currency" text DEFAULT 'MKD' NOT NULL,
	"first_seen_date" date NOT NULL,
	"last_seen_date" date NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_financials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" text NOT NULL,
	"fiscal_year" integer NOT NULL,
	"revenue" numeric(16, 2),
	"net_profit" numeric(16, 2),
	"employees" integer,
	"currency" text DEFAULT 'MKD' NOT NULL,
	"source" text,
	"retrieved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" text NOT NULL,
	"platform" "social_platform" NOT NULL,
	"handle" text,
	"url" text NOT NULL,
	"external_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"social_account_id" uuid NOT NULL,
	"captured_date" date NOT NULL,
	"metric" text NOT NULL,
	"value" numeric(20, 4) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"legal_entity" text NOT NULL,
	"is_self" boolean DEFAULT false NOT NULL,
	"web_enabled" boolean DEFAULT false NOT NULL,
	"web_url" text,
	"web_source" "web_source",
	"monobrand" boolean DEFAULT false NOT NULL,
	"per_location_stock" boolean,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_financials" ADD CONSTRAINT "registry_financials_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_metrics" ADD CONSTRAINT "social_metrics_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingestion_runs_date_idx" ON "ingestion_runs" USING btree ("run_date");--> statement-breakpoint
CREATE INDEX "ingestion_runs_collector_date_idx" ON "ingestion_runs" USING btree ("collector","run_date");--> statement-breakpoint
CREATE UNIQUE INDEX "inv_product_location_date_uq" ON "inventory_snapshots" USING btree ("product_id","location_id","captured_date");--> statement-breakpoint
CREATE INDEX "inv_captured_date_idx" ON "inventory_snapshots" USING btree ("captured_date");--> statement-breakpoint
CREATE INDEX "inv_product_date_idx" ON "inventory_snapshots" USING btree ("product_id","captured_date");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_target_code_uq" ON "locations" USING btree ("target_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "prices_product_date_uq" ON "prices" USING btree ("product_id","captured_date");--> statement-breakpoint
CREATE INDEX "prices_product_date_idx" ON "prices" USING btree ("product_id","captured_date");--> statement-breakpoint
CREATE UNIQUE INDEX "products_target_external_uq" ON "products" USING btree ("target_id","external_id");--> statement-breakpoint
CREATE INDEX "products_target_idx" ON "products" USING btree ("target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_target_year_uq" ON "registry_financials" USING btree ("target_id","fiscal_year");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_target_platform_uq" ON "social_accounts" USING btree ("target_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "social_metrics_account_date_metric_uq" ON "social_metrics" USING btree ("social_account_id","captured_date","metric");--> statement-breakpoint
CREATE INDEX "social_metrics_captured_date_idx" ON "social_metrics" USING btree ("captured_date");--> statement-breakpoint
CREATE INDEX "social_metrics_account_date_idx" ON "social_metrics" USING btree ("social_account_id","captured_date");