CREATE TYPE "public"."stock_adjustment_reason" AS ENUM('count_correction', 'damage', 'loss', 'found', 'other');--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"product_id" uuid NOT NULL,
	"unit_id" uuid,
	"qty_change" integer NOT NULL,
	"reason" "stock_adjustment_reason" NOT NULL,
	"note" text,
	"unit_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"idempotency_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_adjustments_qty_nonzero" CHECK ("stock_adjustments"."qty_change" <> 0)
);
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_adjustments_product_idx" ON "stock_adjustments" USING btree ("company_id","product_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_adjustments_company_idempotency_uq" ON "stock_adjustments" USING btree ("company_id","idempotency_key");