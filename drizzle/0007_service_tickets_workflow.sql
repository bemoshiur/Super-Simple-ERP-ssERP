ALTER TABLE "service_tickets" ADD COLUMN "ticket_no" text;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD COLUMN "sale_id" uuid;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD COLUMN "under_warranty" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD COLUMN "opened_by" uuid;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD COLUMN "closed_by" uuid;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_tickets_company_no_uq" ON "service_tickets" USING btree ("company_id","ticket_no");--> statement-breakpoint
CREATE UNIQUE INDEX "service_tickets_one_active_per_unit_uq" ON "service_tickets" USING btree ("unit_id") WHERE "service_tickets"."status" in ('open', 'in_progress');