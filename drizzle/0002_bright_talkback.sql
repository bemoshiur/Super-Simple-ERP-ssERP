DROP INDEX "brands_company_name_uq";--> statement-breakpoint
DROP INDEX "categories_company_name_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "brands_company_name_uq" ON "brands" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "categories_company_name_uq" ON "categories" USING btree ("company_id",lower("name"));