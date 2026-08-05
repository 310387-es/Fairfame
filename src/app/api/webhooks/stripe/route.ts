import { NextResponse } from "next/server";
import { applyBillingEvent } from "@/billing/checkout";
import { stripeProvider } from "@/billing/stripe";
import { BillingNotConfiguredError } from "@/billing/types";
import { childLogger } from "@/lib/logger";

/**
 * Stripe's webhook (W1.8).
 *
 * Public and unauthenticated by necessity — Stripe will not carry a bearer
 * token — so the `Stripe-Signature` HMAC is the only thing between this
 * endpoint and anyone who guesses the URL. Without it, a POST would be a way to
 * grant yourself the Agency plan, which is why `parseWebhook` refuses outright
 * when `STRIPE_WEBHOOK_SECRET` is absent rather than falling back to trusting
 * the body.
 *
 * **The raw body, not the parsed one.** Signature verification is over the exact
 * bytes Stripe sent; `request.json()` would re-serialise them and every
 * signature would fail. This is the single most common way to get a Stripe
 * webhook wrong, and it fails closed rather than open, which is the right
 * direction but does mean it looks like a credentials problem.
 *
 * **200 for anything verified.** Stripe retries a non-2xx for days and
 * eventually disables the endpoint, so an event we do not model — and there are
 * dozens — is acknowledged and dropped rather than failed. A bad signature is
 * the exception: that is a 400, because pretending to accept a forged event
 * would hide an attack.
 */

const log = childLogger({ module: "webhooks/stripe" });

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const payload = await request.text();

  let event;
  try {
    event = await stripeProvider.parseWebhook(payload, signature);
  } catch (error) {
    if (error instanceof BillingNotConfiguredError) {
      // Not an attack and not our caller's fault: this deployment has no
      // billing. 503 tells Stripe to retry, which is right — the endpoint may
      // be configured by the time it does.
      log.warn("Stripe webhook received, but billing is not configured here");
      return NextResponse.json({ error: "not configured" }, { status: 503 });
    }

    log.warn({ err: error }, "Rejected a Stripe webhook with a bad signature");
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  try {
    const outcome = await applyBillingEvent(event);
    log.info({ eventId: event.id, type: event.type, outcome }, "Stripe webhook handled");
  } catch (error) {
    // Applying failed *after* the event verified — a database problem, most
    // likely. 500 so Stripe retries; swallowing it would lose a payment.
    log.error({ err: error, eventId: event.id }, "Failed to apply a Stripe webhook");
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
