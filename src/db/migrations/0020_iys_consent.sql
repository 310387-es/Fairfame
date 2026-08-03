CREATE TYPE "public"."consent_channel" AS ENUM('message', 'call', 'email');--> statement-breakpoint
CREATE TYPE "public"."consent_source" AS ENUM('web_form', 'in_person', 'import', 'message_reply', 'iys_sync');--> statement-breakpoint
ALTER TABLE "consent_records" DROP CONSTRAINT "consent_records_org_contact_type_key";--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "channel" "consent_channel";--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "source" "consent_source";--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "iys_upload_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "iys_uploaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "iys_upload_error" text;--> statement-breakpoint
CREATE INDEX "consent_records_iys_pending_idx" ON "consent_records" USING btree ("iys_upload_due_at") WHERE type = 'iys' and iys_uploaded_at is null and revoked_at is null;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_org_contact_type_channel_key" UNIQUE NULLS NOT DISTINCT("organization_id","contact_ref","type","channel");