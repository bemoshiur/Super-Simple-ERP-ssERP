ALTER TABLE "product_units" ADD COLUMN "sold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_units" ADD COLUMN "warranty_start" date;--> statement-breakpoint
ALTER TABLE "product_units" ADD COLUMN "warranty_end" date;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "net_total" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "line_no" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_returns" ADD COLUMN "credit_total" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "returned_total" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_company_idempotency_uq" ON "sales" USING btree ("company_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_amounts_nonneg" CHECK ("sale_items"."unit_price" >= 0 and "sale_items"."unit_cost_snapshot" >= 0 and "sale_items"."net_total" >= 0);--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_amounts_nonneg" CHECK ("sales"."subtotal" >= 0 and "sales"."discount" >= 0 and "sales"."total" >= 0 and "sales"."paid" >= 0 and "sales"."due" >= 0 and "sales"."returned_total" >= 0);--> statement-breakpoint
-- Backfill rows created before these columns existed (no discount allocation was stored then).
UPDATE "sale_items" SET "net_total" = "qty" * "unit_price";--> statement-breakpoint
UPDATE "sale_returns" SET "credit_total" = "refund_total";
