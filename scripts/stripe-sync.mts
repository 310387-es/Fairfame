/**
 * Reconciles `PLAN_CATALOG` with the Stripe price catalog.
 *
 *   pnpm stripe:sync            # read-only: reports, changes nothing
 *   pnpm stripe:sync --apply    # creates what is missing
 *
 * **Read-only by default, like `pnpm golive`.** This talks to a payment
 * provider, and a script that writes the moment it is run is one nobody dares
 * run to *look*. Looking is the common case.
 *
 * ## What it is for
 *
 * Checkout resolves prices by lookup key (`src/billing/lookup-keys.ts`), which
 * replaced inline `price_data` because that minted a new Product per session.
 * The cost of pre-created prices is the one inline pricing existed to avoid:
 * two places a price lives, free to drift, with the customer's invoice as the
 * place you find out. This is the thing that stops that — the catalog stays
 * authoritative, and disagreement is a **non-zero exit** rather than a surprise.
 *
 * ## Why drift is reported and never silently repaired
 *
 * A Stripe Price is immutable: its amount cannot be edited. Fixing a changed
 * price means creating a new one and moving the lookup key across
 * (`transfer_lookup_key`), which re-prices nothing for existing subscribers —
 * they stay on the old price object until somebody migrates them deliberately.
 * That is a decision with money attached, so this refuses to make it. It prints
 * exactly what disagrees and stops.
 *
 * Missing prices *are* creatable with `--apply`, because creating one changes
 * nothing for anybody who has already paid.
 */
import { PLAN_CATALOG } from "../src/lib/plans.ts";
import { CATALOG_CURRENCY, expectedPrices } from "../src/billing/lookup-keys.ts";
import { getEnv } from "../src/lib/env.ts";

const apply = process.argv.includes("--apply");

const key = getEnv().STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY is not set — nothing to sync against.");
  process.exit(1);
}

const { default: Stripe } = await import("stripe");
const stripe = new Stripe(key);

/**
 * The mode is read from the key rather than fetched, deliberately.
 *
 * It is the one fact that decides whether a mistake here costs anybody money,
 * so it must be known *before* the first API call rather than from one. A
 * masked tail is printed alongside so two accounts in the same mode are still
 * tellable apart, without putting a secret in a terminal.
 */
const live = key.startsWith("sk_live_");
console.log(`Stripe: ${live ? "LIVE MODE" : "test mode"} (key …${key.slice(-6)})`);
console.log(apply ? "Mode:   apply — will create missing prices\n" : "Mode:   read-only\n");

if (live && apply) {
  console.error("Refusing to write to a LIVE account from a script.");
  console.error("Create live prices from the Stripe dashboard, then re-run read-only to verify.");
  process.exit(1);
}

/** Products are keyed by plan + kind so the add-on is its own line on an invoice. */
function productName(planKey: string, kind: string): string {
  const name = PLAN_CATALOG[planKey as keyof typeof PLAN_CATALOG].name;
  return kind === "base" ? `Fairfame ${name}` : `Fairfame ${name} — extra location`;
}

type Row = { label: string; state: "ok" | "missing" | "drift" | "created"; detail: string };
const rows: Row[] = [];

for (const want of expectedPrices()) {
  const label = want.lookupKey;
  const found = await stripe.prices.list({ lookup_keys: [label], active: true, limit: 1 });
  const price = found.data[0];

  if (!price) {
    if (!apply) {
      rows.push({ label, state: "missing", detail: `would create ${money(want.amount)}` });
      continue;
    }

    // Reuse the product if one already carries this plan+kind, so a second run
    // does not fork a duplicate beside the first.
    const products = await stripe.products.search({
      query: `active:'true' AND metadata['planKey']:'${want.planKey}' AND metadata['kind']:'${want.kind}'`,
      limit: 1,
    });

    const productId =
      products.data[0]?.id ??
      (
        await stripe.products.create({
          name: productName(want.planKey, want.kind),
          metadata: { planKey: want.planKey, kind: want.kind },
          ...(want.kind === "extra_location" ? { unit_label: "location" } : {}),
        })
      ).id;

    const created = await stripe.prices.create({
      product: productId,
      currency: CATALOG_CURRENCY,
      unit_amount: want.amount,
      recurring: { interval: want.interval },
      lookup_key: label,
      nickname: `${PLAN_CATALOG[want.planKey].name} — ${want.kind === "base" ? "" : "extra location, "}${want.interval === "month" ? "monthly" : "annual"}`,
      metadata: {
        planKey: want.planKey,
        kind: want.kind,
        interval: want.interval,
        source: "PLAN_CATALOG",
      },
    });

    rows.push({ label, state: "created", detail: `${money(want.amount)} → ${created.id}` });
    continue;
  }

  const mismatch =
    price.unit_amount !== want.amount ||
    price.currency !== CATALOG_CURRENCY ||
    price.recurring?.interval !== want.interval;

  rows.push(
    mismatch
      ? {
          label,
          state: "drift",
          detail: `stripe ${money(price.unit_amount ?? 0)} ${price.currency}/${price.recurring?.interval} ≠ catalog ${money(want.amount)} ${CATALOG_CURRENCY}/${want.interval}`,
        }
      : { label, state: "ok", detail: `${money(want.amount)} ${want.interval}` },
  );
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const mark = { ok: "  ok    ", missing: "  MISSING", drift: "  DRIFT ", created: "  created" };
for (const row of rows) console.log(`${mark[row.state]} ${row.label.padEnd(44)} ${row.detail}`);

const drift = rows.filter((r) => r.state === "drift");
const missing = rows.filter((r) => r.state === "missing");

console.log();
if (drift.length > 0) {
  console.error(
    `${drift.length} price(s) disagree with PLAN_CATALOG.\n` +
      "A Stripe price is immutable, so this is not repaired automatically: create a new\n" +
      "price and move the lookup key with `transfer_lookup_key`, deciding deliberately\n" +
      "what happens to subscribers already on the old one.",
  );
  process.exit(1);
}

if (missing.length > 0) {
  console.error(`${missing.length} price(s) missing. Re-run with --apply to create them.`);
  process.exit(1);
}

console.log(`Stripe matches PLAN_CATALOG — ${rows.length} price(s).`);
