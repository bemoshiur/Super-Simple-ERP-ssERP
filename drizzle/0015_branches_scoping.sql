CREATE TABLE "stock_transfer_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit_id" uuid,
	"qty" integer NOT NULL,
	CONSTRAINT "stock_transfer_items_qty_positive" CHECK ("stock_transfer_items"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"transfer_no" text NOT NULL,
	"from_branch_id" uuid NOT NULL,
	"to_branch_id" uuid NOT NULL,
	"date" date NOT NULL,
	"note" text,
	"idempotency_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfers_distinct_branches" CHECK ("stock_transfers"."from_branch_id" <> "stock_transfers"."to_branch_id")
);
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "code" text;--> statement-breakpoint
-- Task 14 backfill (plain UPDATEs; fine for v0.x data sizes).
-- 1. Every company has at least one branch ("Main") and exactly one default branch (the oldest when none is marked).
INSERT INTO "branches" ("company_id", "name", "code", "is_default") SELECT c."id", 'Main', 'MAIN', true FROM "companies" c WHERE NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."company_id" = c."id");--> statement-breakpoint
UPDATE "branches" b SET "is_default" = true WHERE b."id" IN (SELECT DISTINCT ON (x."company_id") x."id" FROM "branches" x WHERE NOT EXISTS (SELECT 1 FROM "branches" d WHERE d."company_id" = x."company_id" AND d."is_default") ORDER BY x."company_id", x."created_at", x."id");--> statement-breakpoint
UPDATE "branches" b SET "is_default" = false WHERE b."is_default" AND EXISTS (SELECT 1 FROM "branches" d WHERE d."company_id" = b."company_id" AND d."is_default" AND (d."created_at", d."id") < (b."created_at", b."id"));--> statement-breakpoint
-- 2. Branch codes: the default branch is MAIN, the others BR01, BR02, ... by age.
UPDATE "branches" SET "code" = 'MAIN' WHERE "is_default" AND "code" IS NULL;--> statement-breakpoint
UPDATE "branches" b SET "code" = 'BR' || lpad(r.n::text, 2, '0') FROM (SELECT "id", row_number() OVER (PARTITION BY "company_id" ORDER BY "created_at", "id") AS n FROM "branches" WHERE "code" IS NULL) r WHERE b."id" = r."id";--> statement-breakpoint
ALTER TABLE "branches" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
-- 3. Rows written before Task 14 belong to the company's default (Main) branch.
UPDATE "purchases" t SET "branch_id" = b."id" FROM "branches" b WHERE t."branch_id" IS NULL AND b."company_id" = t."company_id" AND b."is_default";--> statement-breakpoint
UPDATE "sales" t SET "branch_id" = b."id" FROM "branches" b WHERE t."branch_id" IS NULL AND b."company_id" = t."company_id" AND b."is_default";--> statement-breakpoint
UPDATE "payments" t SET "branch_id" = b."id" FROM "branches" b WHERE t."branch_id" IS NULL AND b."company_id" = t."company_id" AND b."is_default";--> statement-breakpoint
UPDATE "expenses" t SET "branch_id" = b."id" FROM "branches" b WHERE t."branch_id" IS NULL AND b."company_id" = t."company_id" AND b."is_default";--> statement-breakpoint
UPDATE "incomes" t SET "branch_id" = b."id" FROM "branches" b WHERE t."branch_id" IS NULL AND b."company_id" = t."company_id" AND b."is_default";--> statement-breakpoint
UPDATE "product_units" t SET "branch_id" = b."id" FROM "branches" b WHERE t."branch_id" IS NULL AND b."company_id" = t."company_id" AND b."is_default";--> statement-breakpoint
UPDATE "stock_movements" t SET "branch_id" = b."id" FROM "branches" b WHERE t."branch_id" IS NULL AND b."company_id" = t."company_id" AND b."is_default";--> statement-breakpoint
UPDATE "stock_adjustments" t SET "branch_id" = b."id" FROM "branches" b WHERE t."branch_id" IS NULL AND b."company_id" = t."company_id" AND b."is_default";--> statement-breakpoint
UPDATE "sale_returns" t SET "branch_id" = b."id" FROM "branches" b WHERE t."branch_id" IS NULL AND b."company_id" = t."company_id" AND b."is_default";--> statement-breakpoint
UPDATE "purchase_returns" t SET "branch_id" = b."id" FROM "branches" b WHERE t."branch_id" IS NULL AND b."company_id" = t."company_id" AND b."is_default";--> statement-breakpoint
UPDATE "service_tickets" t SET "branch_id" = b."id" FROM "branches" b WHERE t."branch_id" IS NULL AND b."company_id" = t."company_id" AND b."is_default";--> statement-breakpoint
UPDATE "users" t SET "branch_id" = b."id" FROM "branches" b WHERE t."branch_id" IS NULL AND b."company_id" = t."company_id" AND b."is_default";--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_unit_id_product_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."product_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_branch_id_branches_id_fk" FOREIGN KEY ("from_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_branch_id_branches_id_fk" FOREIGN KEY ("to_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_transfer_items_transfer_idx" ON "stock_transfer_items" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "stock_transfer_items_unit_idx" ON "stock_transfer_items" USING btree ("unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfers_company_no_uq" ON "stock_transfers" USING btree ("company_id","transfer_no");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfers_company_idempotency_uq" ON "stock_transfers" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "stock_transfers_company_date_idx" ON "stock_transfers" USING btree ("company_id","date");--> statement-breakpoint
CREATE INDEX "stock_transfers_from_idx" ON "stock_transfers" USING btree ("company_id","from_branch_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_to_idx" ON "stock_transfers" USING btree ("company_id","to_branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_company_code_uq" ON "branches" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "users_branch_idx" ON "users" USING btree ("company_id","branch_id");--> statement-breakpoint
CREATE INDEX "stock_movements_branch_product_idx" ON "stock_movements" USING btree ("company_id","branch_id","product_id");--> statement-breakpoint
CREATE INDEX "product_units_branch_product_status_idx" ON "product_units" USING btree ("company_id","branch_id","product_id","status");--> statement-breakpoint
CREATE INDEX "purchases_company_branch_date_idx" ON "purchases" USING btree ("company_id","branch_id","date");--> statement-breakpoint
CREATE INDEX "stock_adjustments_branch_idx" ON "stock_adjustments" USING btree ("company_id","branch_id","created_at");--> statement-breakpoint
CREATE INDEX "purchase_returns_company_branch_date_idx" ON "purchase_returns" USING btree ("company_id","branch_id","date");--> statement-breakpoint
CREATE INDEX "sale_returns_company_branch_date_idx" ON "sale_returns" USING btree ("company_id","branch_id","date");--> statement-breakpoint
CREATE INDEX "sales_company_branch_date_idx" ON "sales" USING btree ("company_id","branch_id","date");--> statement-breakpoint
CREATE INDEX "expenses_company_branch_date_idx" ON "expenses" USING btree ("company_id","branch_id","date");--> statement-breakpoint
CREATE INDEX "incomes_company_branch_date_idx" ON "incomes" USING btree ("company_id","branch_id","date");--> statement-breakpoint
CREATE INDEX "payments_company_branch_date_idx" ON "payments" USING btree ("company_id","branch_id","date");--> statement-breakpoint
CREATE INDEX "service_tickets_company_branch_status_idx" ON "service_tickets" USING btree ("company_id","branch_id","status");--> statement-breakpoint
-- 4. The manager system role gets the new branches.all permission (salesman stays restricted to its branch).
INSERT INTO "role_permissions" ("company_id", "role_id", "permission") SELECT r."company_id", r."id", 'branches.all' FROM "roles" r WHERE r."is_system" AND r."name" = 'manager' ON CONFLICT DO NOTHING;
