-- The USD-only ladder, and the shape that replaces hard location caps
-- (decided 11 Aug 2026; rationale in docs/05 §1–2).
--
-- Two changes travel together because neither works alone.
--
-- **The catalog is one currency.** It was TRY (kuruş) on the argument that
-- Türkiye is the launch market. That produced a price list to reprice against
-- inflation on a schedule nobody owns, for a product that is global. The
-- catalog is USD (cents) and the payment provider converts at charge time —
-- Stripe presents local currency where it can, iyzico charges the TRY
-- equivalent when that adapter goes live. `plans.currency` still exists and is
-- still read by every formatter; there is simply one value in it today.
--
-- **Price is base + extras, not a cap.** A plan used to say "max 3 locations"
-- and a fourth branch meant a tier jump. Now a plan *includes* N and prices the
-- rest, so revenue tracks the thing that drives our cost. `max_locations`
-- survives as the hard ceiling of the tier, not as the thing being sold.
--
-- Non-destructive: every column is added nullable or with a default, and the
-- data step updates the four catalog rows in place. No row is deleted, and a
-- deployment that has not run `pnpm db:seed` since is still repriced by this.

ALTER TABLE "plans" ADD COLUMN "price_year" integer;--> statement-breakpoint

-- Not null with a default of 1: every existing tier included exactly one
-- location's worth of base price before this migration, so 1 is the true
-- historical value rather than a placeholder.
ALTER TABLE "plans" ADD COLUMN "included_locations" integer NOT NULL DEFAULT 1;--> statement-breakpoint

ALTER TABLE "plans" ADD COLUMN "price_extra_location_month" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "price_extra_location_year" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "provider_price_id_year" text;--> statement-breakpoint

COMMENT ON COLUMN "plans"."price_month" IS 'Minor units of currency — USD cents since 11 Aug 2026 (was TRY kuruş). Null for Agency: quoted per deal.';--> statement-breakpoint
COMMENT ON COLUMN "plans"."price_year" IS 'Minor units (cents), annual billing: 10x monthly (two months free). Null = no annual option / custom.';--> statement-breakpoint
COMMENT ON COLUMN "plans"."included_locations" IS 'Locations included in the base price. Extras are priced, not refused — max_locations is the separate hard ceiling.';--> statement-breakpoint
COMMENT ON COLUMN "plans"."price_extra_location_month" IS 'Minor units (cents) per additional location per month. Null = extras not purchasable (Starter) or per deal (Agency).';--> statement-breakpoint
COMMENT ON COLUMN "plans"."price_extra_location_year" IS 'Minor units (cents) per additional location per year.';--> statement-breakpoint
COMMENT ON COLUMN "plans"."provider_price_id_year" IS 'Annual price id at the payment provider. Sibling of provider_price_id, which stays monthly.';--> statement-breakpoint

-- The catalog itself.
--
-- This must stay byte-identical in meaning to `PLAN_CATALOG` in
-- src/lib/plans.ts, which is what `pnpm db:seed` writes. The seed is the source
-- of truth; this data step exists so an already-migrated database is repriced
-- without waiting for someone to remember to re-seed. A second seed run after
-- this migration is a no-op.
--
-- `provider_price_id` and `provider_price_id_year` are deliberately left alone:
-- they belong to the payment provider, are set when a price object is created
-- there, and a repricing that silently pointed at a stale Stripe price would
-- charge the old amount while the screen showed the new one.
INSERT INTO "plans" ("key", "name", "price_month", "price_year", "currency", "interval",
                     "included_locations", "price_extra_location_month", "price_extra_location_year",
                     "entitlements")
VALUES
  ('starter', 'Starter', 2900, 29000, 'USD', 'month', 1, NULL, NULL, '{
    "features": {
      "ai_replies": true, "social_sources": false, "competitor_watch": false,
      "widgets": true, "scheduled_reports": false, "analytics": false,
      "seo_pages": true, "api_access": false, "white_label": false,
      "benchmarking": false, "saved_views": false, "bulk_actions": false,
      "sla_tracking": true, "crm": false, "surveys": false,
      "messaging": false, "broadcasts": false, "agency_console": false
    },
    "limits": {
      "max_locations": 1, "max_team_members": 3, "max_widgets": 1,
      "requests_per_month": 100, "ai_analyses_per_month": 300
    },
    "metered": { "sms_credits": 0, "whatsapp_conversations": 0, "ai_tokens": 200000 }
  }'::jsonb),

  ('growth', 'Growth', 8900, 89000, 'USD', 'month', 1, 4900, 49000, '{
    "features": {
      "ai_replies": true, "social_sources": true, "competitor_watch": false,
      "widgets": true, "scheduled_reports": true, "analytics": true,
      "seo_pages": true, "api_access": false, "white_label": false,
      "benchmarking": false, "saved_views": true, "bulk_actions": true,
      "sla_tracking": true, "crm": true, "surveys": true,
      "messaging": true, "broadcasts": true, "agency_console": false
    },
    "limits": {
      "max_locations": 5, "max_team_members": 10, "max_widgets": null,
      "requests_per_month": null, "ai_analyses_per_month": 1000
    },
    "metered": { "sms_credits": 100, "whatsapp_conversations": 250, "ai_tokens": 1000000 }
  }'::jsonb),

  ('pro', 'Pro', 22900, 229000, 'USD', 'month', 3, 5900, 59000, '{
    "features": {
      "ai_replies": true, "social_sources": true, "competitor_watch": true,
      "widgets": true, "scheduled_reports": true, "analytics": true,
      "seo_pages": true, "api_access": true, "white_label": false,
      "benchmarking": true, "saved_views": true, "bulk_actions": true,
      "sla_tracking": true, "crm": true, "surveys": true,
      "messaging": true, "broadcasts": true, "agency_console": false
    },
    "limits": {
      "max_locations": 25, "max_team_members": null, "max_widgets": null,
      "requests_per_month": null, "ai_analyses_per_month": 2500
    },
    "metered": { "sms_credits": 250, "whatsapp_conversations": 500, "ai_tokens": 2000000 }
  }'::jsonb),

  -- Agency is quoted per deal, so price_month is null while included_locations
  -- and the extra-location price are real: the sales anchor is $299/mo
  -- including 10 client locations, +$29/location wholesale.
  ('agency', 'Agency', NULL, NULL, 'USD', 'month', 10, 2900, 29000, '{
    "features": {
      "ai_replies": true, "social_sources": true, "competitor_watch": true,
      "widgets": true, "scheduled_reports": true, "analytics": true,
      "seo_pages": true, "api_access": true, "white_label": true,
      "benchmarking": true, "saved_views": true, "bulk_actions": true,
      "sla_tracking": true, "crm": true, "surveys": true,
      "messaging": true, "broadcasts": true, "agency_console": true
    },
    "limits": {
      "max_locations": null, "max_team_members": null, "max_widgets": null,
      "requests_per_month": null, "ai_analyses_per_month": null
    },
    "metered": { "sms_credits": 2500, "whatsapp_conversations": 2500, "ai_tokens": 20000000 }
  }'::jsonb)

ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "price_month" = EXCLUDED."price_month",
  "price_year" = EXCLUDED."price_year",
  "currency" = EXCLUDED."currency",
  "interval" = EXCLUDED."interval",
  "included_locations" = EXCLUDED."included_locations",
  "price_extra_location_month" = EXCLUDED."price_extra_location_month",
  "price_extra_location_year" = EXCLUDED."price_extra_location_year",
  "entitlements" = EXCLUDED."entitlements",
  "updated_at" = now();
