ALTER TABLE "purchase_items" ADD COLUMN "net_total" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- Backfill rows created before this column existed: gross line total (exact for invoices without a discount).
UPDATE "purchase_items" SET "net_total" = "qty" * "unit_cost";
