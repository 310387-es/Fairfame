"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { isRoadmapSource } from "@/connectors/roadmap";
import { schema } from "@/db/client";
import { childLogger } from "@/lib/logger";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * "We would use you if you read our Yemeksepeti reviews", recorded (W4.2).
 *
 * The whole action is one insert, and the two interesting decisions are both
 * about what it refuses.
 *
 * **The key must be a roadmap source.** `provider_key` is free text in the
 * database on purpose — these name sources that are deliberately absent from
 * `PROVIDERS` — so the validation has to happen somewhere, and a server action
 * is the boundary where untrusted input arrives. Without it the column is a
 * place a caller can write arbitrary strings into our roadmap signal.
 *
 * **A repeat press is a success, not an error.** The unique index means one row
 * per organization per source, and somebody pressing again is not doing
 * anything wrong — they are asking whether it registered. `on conflict do
 * nothing` and a cheerful answer is the honest response; an error toast reading
 * "already requested" would be the product telling somebody off for wanting
 * something twice.
 */

const log = childLogger({ module: "server/connections" });

const requestSchema = z.object({ providerKey: z.string().min(1).max(64) });

export async function requestIntegrationAction(input: {
  providerKey: string;
}): Promise<ActionResult> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Unknown integration.");
  if (!isRoadmapSource(parsed.data.providerKey)) {
    return { ok: false, error: "Unknown integration.", code: "invalid_input" };
  }

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await tx
          .insert(schema.integrationRequests)
          .values({
            organizationId: actor.organizationId,
            providerKey: parsed.data.providerKey,
            requestedByUserId: actor.userId,
          })
          .onConflictDoNothing();
      },
      // Any member may say what their business needs. This is a signal to us,
      // not a change to the account, so gating it behind admin would filter the
      // demand signal down to whoever happens to hold the billing role.
      { minimumRole: "member" },
    );

    revalidatePath("/connections");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "requestIntegration failed");
    return toActionResult(error);
  }
}
