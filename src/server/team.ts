"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { setMemberLocations, ScopeError } from "@/auth/scope";
import { withAuthenticatedTenant } from "@/auth/session";
import { childLogger } from "@/lib/logger";
import { toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Team actions (P2 follow-up).
 *
 * `member_locations` shipped with T4 and had no way to write to it outside a
 * database console, which made a location-scoped role a thing the product
 * enforced but could not be told about. This is that missing half.
 *
 * The rule lives in `src/auth/scope.ts`, not here — same reason as everywhere
 * else in this phase: the next caller should inherit it.
 */

const log = childLogger({ module: "server/team" });

const schema = z.object({
  userId: z.uuid(),
  /**
   * Empty means unrestricted. The screen never sends an empty list to mean
   * "sees nothing" — it offers "all locations" as its own choice and refuses to
   * save "only these" with nothing ticked.
   */
  locationIds: z.array(z.uuid()).max(200),
});

export async function setMemberLocationsAction(input: {
  userId: string;
  locationIds: string[];
}): Promise<ActionResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick at least one location." };

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await setMemberLocations(tx, actor, parsed.data);
      },
      { minimumRole: "admin" },
    );

    // The scope decides what every screen reads, not just this one.
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    if (error instanceof ScopeError) return { ok: false, error: error.message };
    log.warn({ err: error }, "setMemberLocations failed");
    return toActionResult(error);
  }
}
