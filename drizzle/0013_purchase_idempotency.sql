ALTER TABLE "purchases" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "idempotency_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_company_idempotency_uq" ON "purchases" USING btree ("company_id","idempotency_key");