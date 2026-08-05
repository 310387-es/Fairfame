"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { schema } from "@/db/client";
import { requireFeature } from "@/lib/entitlements";
import { childLogger } from "@/lib/logger";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Naming and un-naming competitors (P3-T6).
 *
 * `admin`, unlike the report schedule: a competitor is organization-wide
 * configuration everybody's benchmark is drawn against, not a personal
 * arrangement. Gated on `benchmarking`, which `docs/05` puts at Pro.
 *
 * The reference is stored as typed and **never parsed here**. Only the adapter
 * that eventually fetches a listing knows whether it is a place id, a handle or
 * a URL, and validating it against today's guess would reject the format the
 * real connector turns out to want.
 */

const log = childLogger({ module: "server/competitors" });

const addSchema = z.object({
  name: z.string().trim().min(1).max(80),
  provider: z.string().trim().min(1).max(40),
  externalRef: z.string().trim().min(1).max(500),
  locationId: z.union([z.uuid(), z.literal("")]).transform((v) => (v === "" ? null : v)),
});

export async function addCompetitorAction(input: {
  name: string;
  provider: string;
  externalRef: string;
  locationId: string;
}): Promise<ActionResult> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success)
    return invalidInput(parsed.error, "Give the competitor a name and a listing.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await requireFeature({ organizationId: actor.organizationId, tx }, "benchmarking");

        await tx
          .insert(schema.competitors)
          .values({ organizationId: actor.organizationId, ...parsed.data })
          // Naming the same listing twice is a duplicate row in a comparison
          // table, not a second competitor — so re-adding it just renames.
          .onConflictDoUpdate({
            target: [
              schema.competitors.organizationId,
              schema.competitors.locationId,
              schema.competitors.provider,
              schema.competitors.externalRef,
            ],
            set: { name: parsed.data.name, enabled: true, updatedAt: new Date() },
          });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/insights");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "addCompetitor failed");
    return toActionResult(error);
  }
}

export async function removeCompetitorAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid input.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        // Deleted rather than disabled: nothing is stored *about* a competitor,
        // so there is no history for a soft delete to preserve. RLS makes the
        // organization clause belt and braces.
        await tx
          .delete(schema.competitors)
          .where(
            and(
              eq(schema.competitors.id, parsed.data.id),
              eq(schema.competitors.organizationId, actor.organizationId),
            ),
          );
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/insights");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "removeCompetitor failed");
    return toActionResult(error);
  }
}
