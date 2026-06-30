ALTER TABLE "products" ADD COLUMN "product_type" text;--> statement-breakpoint
CREATE INDEX "products_product_type_idx" ON "products" USING btree ("product_type");