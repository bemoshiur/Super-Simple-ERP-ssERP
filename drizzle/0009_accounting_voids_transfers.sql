ALTER TYPE "public"."payment_ref_type" ADD VALUE 'transfer';--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "voided_by" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "incomes" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incomes" ADD COLUMN "voided_by" uuid;--> statement-breakpoint
ALTER TABLE "incomes" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reverses_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incomes" ADD CONSTRAINT "incomes_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_company_account_date_idx" ON "payments" USING btree ("company_id","account_id","date");