-- P5-T2 — consent to hear from Fairfame, recorded at the point of collection.
--
-- Two columns rather than one, for the same reason `consents.granted_at` is
-- separate from `consents.status` on the customer side: a permission and the
-- moment it was given are different facts, and only the second is evidence.
-- A boolean alone answers "may we?" and cannot answer "since when, and did
-- they say so before or after we started sending?" — which is the question
-- anybody auditing a mailing list actually asks.
--
-- Non-destructive: both columns are additive, the flag defaults to false, and
-- every row that already exists is therefore backfilled to *not consented*.
-- That is the honest backfill. Nobody who signed up before this migration was
-- ever shown a checkbox, so nobody can be recorded as having ticked one, and a
-- default of true would have manufactured consent for the entire user table in
-- a single statement.
--
-- Nothing sends against these columns yet. The record exists first, deliberately
-- — the same ordering as the İYS gate, which refuses before the gateway that
-- would approve anything is installed.
ALTER TABLE "users" ADD COLUMN "marketing_email_consent" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "marketing_email_consent_at" timestamptz;--> statement-breakpoint

-- The timestamp only means anything next to a true flag, and a row carrying a
-- date while claiming no consent is a contradiction rather than a shape the
-- application should have to interpret at read time.
ALTER TABLE "users" ADD CONSTRAINT "users_marketing_consent_dated"
  CHECK ("marketing_email_consent" = false OR "marketing_email_consent_at" IS NOT NULL);
