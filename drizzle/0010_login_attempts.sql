CREATE TABLE "login_attempts" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "login_attempts_window_idx" ON "login_attempts" USING btree ("window_start");