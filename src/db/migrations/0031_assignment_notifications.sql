-- Tell people when work is handed to them (P2-T4 follow-up).
--
-- Assignment shipped in Phase 2 audit-logged and silent: `assignee_user_id` was
-- written, `audit_logs` recorded it, and the person on the receiving end was
-- told nothing. They found out by opening the inbox and remembering to use the
-- "Assigned to me" filter. For a product whose Phase 2 headline is "assign to a
-- teammate", that is a handoff with no handshake.
--
-- Two values, mirroring the SLA pair, and for the same reason: one alert per
-- item while the number is small enough to act on, one rollup once it is not.
-- Bulk assignment can move fifty reviews in a click, and fifty notifications is
-- a wall somebody scrolls past rather than a list they work through.
--
-- `ADD VALUE` runs inside the migration transaction, which Postgres allows on
-- 12+ so long as the new value is not *used* in the same transaction. Nothing
-- here writes a row, so it is not.
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'review_assigned';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'assignment_rollup';
