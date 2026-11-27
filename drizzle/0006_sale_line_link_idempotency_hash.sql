ALTER TABLE "product_units" ADD COLUMN "sale_item_id" uuid;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "idempotency_hash" text;--> statement-breakpoint
-- Backfill: units currently out with a customer point at their most recent sale line.
UPDATE "product_units" u SET "sale_item_id" = (
  SELECT si."id" FROM "sale_items" si JOIN "sales" s ON s."id" = si."sale_id"
  WHERE si."unit_id" = u."id" AND si."company_id" = u."company_id"
  ORDER BY s."created_at" DESC, si."id" DESC LIMIT 1
) WHERE u."status" IN ('sold', 'in_service');
