ALTER TABLE "connections" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "next_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "last_error" text;--> statement-breakpoint
-- Existing connections are due immediately: a null next_sync_at means "no
-- pacing decision has been made yet", which the scan treats as eligible.
CREATE INDEX "connections_due_idx" ON "connections" USING btree ("status","next_sync_at");
