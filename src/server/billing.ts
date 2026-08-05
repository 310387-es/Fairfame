"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { requireActor, assertRoleAtLeast } from "@/auth/session";
import { startCheckout } from "@/billing/checkout";
import { childLogger } from "@/lib/logger";
import { PLAN_KEYS } from "@/lib/plans";
import { dashboardBaseUrl } from "@/lib/urls";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Starting a paid subscription (W1.8).
 *
 * **Owner only.** Every other admin action changes what the product does;
 * this one changes what the business is charged, and "admin" in this product
 * means somebody who can manage locations and templates — not somebody who
 * should be able to commit their employer to a monthly bill.
 */

const log = childLogger({ module: "server/billing" });

const schema = z.object({ planKey: z.enum(PLAN_KEYS) });

export async function startCheckoutAction(input: { planKey: string }): Promise<ActionResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Unknown plan.");

  let url: string;

  try {
    const actor = await requireActor();
    assertRoleAtLeast(actor, "owner");

    const outcome = await startCheckout({
      organizationId: actor.organizationId,
      planKey: parsed.data.planKey,
      // Back to the plan section either way, so the answer to "did that work"
      // is on the screen that asked the question.
      successUrl: `${dashboardBaseUrl()}/settings?checkout=done#plan`,
      cancelUrl: `${dashboardBaseUrl()}/settings?checkout=cancelled#plan`,
    });

    if (!outcome.ok) {
      // Named reasons rather than one message: "we cannot bill in your currency
      // yet" and "that plan is quoted per deal" send a customer to different
      // places, and only one of them is something we can fix by deploying.
      return { ok: false, error: "Checkout is not available.", code: `billing:${outcome.reason}` };
    }

    url = outcome.url;
  } catch (error) {
    log.warn({ err: error }, "startCheckout failed");
    return toActionResult(error);
  }

  // Outside the try: `redirect` works by throwing, so catching it here would
  // turn a successful checkout into a reported failure.
  redirect(url);
}
