/**
 * Posts a Stripe billing webhook to this deployment, as Stripe would.
 *
 *   pnpm mock:billing --org <slug> --plan growth
 *   pnpm mock:billing --org <slug> --plan pro --status past_due
 *   pnpm mock:billing --org <slug> --event canceled
 *
 * **The point is that it is not a back door**, exactly as `mock-inbound.mts`
 * is not one for WhatsApp. It builds Stripe's own event envelope, signs it with
 * `STRIPE_WEBHOOK_SECRET` using Stripe's scheme — `t=<unix>,v1=<hmac of
 * "<t>.<body>">` — and POSTs it to the real `/api/webhooks/stripe`. So the
 * signature check, the SDK's `constructEvent`, the normaliser, the metadata
 * lookup and `assignPlan` are all exercised. An endpoint that skipped them
 * would prove the plan screen works while leaving untested the path a real
 * payment actually takes.
 *
 * **Why it is needed at all:** Stripe cannot reach `localhost`. The usual
 * answer is `stripe listen --forward-to`, which needs the Stripe CLI; this is
 * the same thing without the install, and it signs rather than trusting.
 *
 * It moves a *subscription*, not money. Nothing here charges anybody.
 */

import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeDatabasePools, getAdminDb, schema } from "../src/db/client.ts";
import { getEnv } from "../src/lib/env.ts";
import { PLAN_KEYS } from "../src/lib/plans.ts";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const env = getEnv();

if (!env.STRIPE_WEBHOOK_SECRET) {
  console.error(
    "STRIPE_WEBHOOK_SECRET is not set. The webhook refuses an unsigned body, which is correct —\n" +
      "an unverified billing webhook is a way to grant yourself a plan. Set any value locally and\n" +
      "this script will sign with it.",
  );
  process.exit(1);
}

const slug = flag("org") ?? "demo";
const planKey = flag("plan") ?? "growth";
const status = flag("status") ?? "active";
const kind = flag("event") ?? "updated";

if (!(PLAN_KEYS as readonly string[]).includes(planKey)) {
  console.error(`Unknown plan "${planKey}". One of: ${PLAN_KEYS.join(", ")}`);
  process.exit(1);
}

const [organization] = await getAdminDb()
  .select({ id: schema.organizations.id, name: schema.organizations.name })
  .from(schema.organizations)
  .where(eq(schema.organizations.slug, slug))
  .limit(1);

if (!organization) {
  console.error(`No organization with slug "${slug}".`);
  await closeDatabasePools();
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const periodEnd = now + 30 * 24 * 60 * 60;

const type =
  kind === "canceled"
    ? "customer.subscription.deleted"
    : kind === "created"
      ? "customer.subscription.created"
      : "customer.subscription.updated";

/**
 * Stripe's shape, not ours.
 *
 * `current_period_end` sits on the subscription *item* in the 2025 API
 * versions, which is what the adapter reads first — so the fixture puts it
 * there, and a normaliser that only understood the old top-level field would
 * fail here rather than in production.
 */
const event = {
  id: `evt_mock_${now}`,
  object: "event",
  api_version: "2025-08-27.basil",
  created: now,
  type,
  data: {
    object: {
      id: `sub_mock_${organization.id.slice(0, 8)}`,
      object: "subscription",
      status: kind === "canceled" ? "canceled" : status,
      metadata: { organizationId: organization.id, planKey },
      items: {
        object: "list",
        data: [{ id: "si_mock", object: "subscription_item", current_period_end: periodEnd }],
      },
    },
  },
};

const body = JSON.stringify(event);
const signed = `${now}.${body}`;
const signature = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(signed).digest("hex");

const url = `${env.BETTER_AUTH_URL}/api/webhooks/stripe`;

const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    // Stripe's own header format. Getting this wrong is the whole test.
    "stripe-signature": `t=${now},v1=${signature}`,
  },
  body,
});

console.log(`${type} → ${organization.name} (${slug})`);
console.log(`  plan=${planKey} status=${kind === "canceled" ? "canceled" : status}`);
console.log(`  ${response.status} ${await response.text()}`);

await closeDatabasePools();
