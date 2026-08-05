-- Remembering who we are billing (W1.8, docs/remediation-plan.md).
--
-- Checkout needs somewhere to write the provider's own identifiers, and there
-- was nowhere: `subscriptions` carried a plan, a status and a period end, which
-- is everything except the two things a payment provider hands back.
--
-- **The customer belongs to the organization, the subscription to the
-- subscription.** A business has one customer record with a provider for as
-- long as it exists — through cancellations, restarts and plan changes — and
-- putting it on `subscriptions` would mint a second Stripe customer every time
-- somebody re-subscribed, which is how one business ends up with three of them
-- and an invoice history split across all three.
--
-- `billing_provider` sits beside the id because an id is meaningless without
-- it: `cus_123` is a Stripe customer, and the same column would hold an iyzico
-- reference for a Turkish organization. Two providers, one column, and the
-- provider named rather than inferred from the shape of the string.
ALTER TABLE "organizations" ADD COLUMN "billing_provider" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "billing_customer_id" text;--> statement-breakpoint

-- The provider's id for *this* subscription, so a webhook can find the row it
-- is about without guessing from the organization and a timestamp.
ALTER TABLE "subscriptions" ADD COLUMN "provider_subscription_id" text;--> statement-breakpoint

-- Unique per provider, not globally: two providers may legitimately mint the
-- same opaque string, and a collision across them is not a duplicate.
CREATE UNIQUE INDEX "organizations_billing_customer_key"
  ON "organizations" ("billing_provider", "billing_customer_id")
  WHERE "billing_customer_id" IS NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX "subscriptions_provider_subscription_key"
  ON "subscriptions" ("provider_subscription_id")
  WHERE "provider_subscription_id" IS NOT NULL;
