"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/auth/config";
import { withAuthenticatedTenant } from "@/auth/session";
import { linkClient, unlinkClient } from "@/agency/clients";
import { parseBranding } from "@/agency/branding";
import { schema } from "@/db/client";
import { requireFeature } from "@/lib/entitlements";
import { childLogger } from "@/lib/logger";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";
import { eq } from "drizzle-orm";

/**
 * Agency and white-label mutations (P4-T5).
 *
 * Two families, gated differently on purpose:
 *
 *   - **The roster** (`link`, `unlink`, `switch`) needs only admin. Managing
 *     which organizations appear on your own console is bookkeeping about
 *     access you already have — `linkClient` refuses anything you are not a
 *     member of, so there is nothing here to sell.
 *   - **Branding** needs `white_label` *when it changes what somebody else's
 *     customers see*. An organization setting its own colour is not that.
 */

const log = childLogger({ module: "server/agency" });

export async function linkClientAction(input: {
  slug: string;
  label?: string | null;
}): Promise<ActionResult> {
  const parsed = z
    .object({
      slug: z.string().trim().min(1).max(64),
      label: z.string().trim().max(80).nullish(),
    })
    .safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid client.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        const result = await linkClient(tx, actor.organizationId, actor.userId, {
          clientSlug: parsed.data.slug,
          label: parsed.data.label?.trim() ? parsed.data.label.trim() : null,
        });

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "agency.client_linked",
          entity: `organization:${result.clientOrganizationId}`,
          meta: { slug: parsed.data.slug },
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/agency");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "linkClient failed");
    return toActionResult(error);
  }
}

export async function unlinkClientAction(input: {
  clientOrganizationId: string;
}): Promise<ActionResult> {
  const parsed = z.object({ clientOrganizationId: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid client.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await unlinkClient(tx, actor.organizationId, parsed.data.clientOrganizationId);

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "agency.client_unlinked",
          entity: `organization:${parsed.data.clientOrganizationId}`,
          meta: {},
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/agency");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "unlinkClient failed");
    return toActionResult(error);
  }
}

/**
 * Switches which organization the session is looking at.
 *
 * **Delegated to BetterAuth rather than writing `sessions.active_organization_id`
 * ourselves.** Its endpoint checks membership, and that check is the only thing
 * standing between this action and "set my tenant context to any id" — which is
 * the single worst bug this codebase could have. Re-implementing it here would
 * mean two membership checks, and the second one would eventually be the one
 * that was wrong.
 */
export async function switchOrganizationAction(input: {
  organizationId: string;
}): Promise<ActionResult> {
  const parsed = z.object({ organizationId: z.uuid() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid organization.");

  try {
    await auth.api.setActiveOrganization({
      headers: await headers(),
      body: { organizationId: parsed.data.organizationId },
    });

    // The whole shell changes — nav, location switcher, entitlements.
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "switchOrganization failed");
    return { ok: false, error: "You are not a member of that organization." };
  }
}

const brandingInputSchema = z.object({
  senderName: z.string().trim().max(80).nullable(),
  primaryColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #3d5af1.")
    .nullable(),
  logoUrl: z.string().trim().url().max(500).nullable(),
  hidePoweredBy: z.boolean(),
  customDomain: z
    .string()
    .trim()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "Use a hostname like reviews.example.com.")
    .max(200)
    .nullable(),
});

/**
 * Saves this organization's brand.
 *
 * `hidePoweredBy` and `customDomain` are the two that need `white_label`: the
 * first removes our mark from a page, the second serves it from somebody else's
 * address. A name, a logo and a colour do not — an ordinary business putting
 * its own logo on its own review page is just having a logo.
 */
export async function saveBrandingAction(input: unknown): Promise<ActionResult> {
  const parsed = brandingInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput(parsed.error, parsed.error.issues[0]?.message ?? "Invalid branding.");
  }

  const data = parsed.data;

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        if (data.hidePoweredBy || data.customDomain) {
          await requireFeature({ organizationId: actor.organizationId, tx }, "white_label");
        }

        await tx
          .update(schema.organizations)
          .set({
            logo: data.logoUrl,
            customDomain: data.customDomain,
            branding: parseBranding({
              ...(data.senderName ? { senderName: data.senderName } : {}),
              ...(data.primaryColor ? { primaryColor: data.primaryColor } : {}),
              hidePoweredBy: data.hidePoweredBy,
            }),
            updatedAt: new Date(),
          })
          .where(eq(schema.organizations.id, actor.organizationId));

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "organization.branding_updated",
          entity: `organization:${actor.organizationId}`,
          // The domain is the part somebody will ask about later.
          meta: { customDomain: data.customDomain, hidePoweredBy: data.hidePoweredBy },
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "saveBranding failed");
    return toActionResult(error);
  }
}
