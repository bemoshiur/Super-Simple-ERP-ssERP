ALTER TABLE "stock_transfers" ADD COLUMN "idempotency_hash" text;--> statement-breakpoint
-- Managers got branches.all in 0015; their signed-in sessions still carry the old permission list. Sign them out once so the
-- next login picks it up (custom roles cloned from manager are NOT changed: grant branches.all on the Roles page if wanted).
UPDATE "users" SET "session_version" = "session_version" + 1 WHERE "role_id" IN (SELECT "id" FROM "roles" WHERE "is_system" AND "name" = 'manager');
