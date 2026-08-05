"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { requireFeature } from "@/lib/entitlements";
import { childLogger } from "@/lib/logger";
import { setSchedule } from "@/reports/store";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * The one write behind the Insights report card (P3-T5).
 *
 * `member`, not `admin`: a schedule is a personal arrangement — "email me this
 * every Monday" — about data the caller can already read on the screen they set
 * it from. It creates nothing another person can see and sends to nobody else,
 * which is exactly why the row is keyed by the user.
 *
 * The entitlement is checked here *and* again at send time in the sweep. Not
 * belt and braces for its own sake: a plan can lapse between the two, and a
 * report that kept arriving after a downgrade would be the product ignoring its
 * own gate.
 */

const log = childLogger({ module: "server/reports" });

const inputSchema = z.object({
  enabled: z.boolean(),
  cadence: z.enum(["weekly", "monthly"]),
  /** The empty string is the explicit "every branch I can see" choice. */
  locationId: z
    .union([z.uuid(), z.literal("")])
    .transform((value) => (value === "" ? null : value)),
});

export async function setReportScheduleAction(input: {
  enabled: boolean;
  cadence: string;
  locationId: string;
}): Promise<ActionResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid input.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "scheduled_reports");

        return setSchedule(tx, actor.organizationId, actor.userId, parsed.data);
      },
      { minimumRole: "member" },
    );

    revalidatePath("/insights");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "setReportSchedule failed");
    return toActionResult(error);
  }
}
