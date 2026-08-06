"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { withAuthenticatedTenant } from "@/auth/session";
import { connectSource, syncConnectionWithin, toConnection } from "@/connectors/sync";
import { schema } from "@/db/client";
import { requireFeature, requireWithinLimit } from "@/lib/entitlements";
import { getEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";
import { FIRST_PARTY_PROVIDER } from "@/connectors/firstparty";
import { getProvider, resolveMode } from "@/connectors/providers";
import { requestAnalysis, requestNotifications } from "@/jobs/client";
import { connectSourceSchema, parseCreateLocation, syncNowSchema } from "@/server/location-input";
import { setPublicPage } from "@/seo/store";

/**
 * Location and source-connection mutations.
 *
 * Every action here is gated twice: by role (can this member do it?) and by
 * entitlement (does the plan allow it?). Both checks are server-side. The UI
 * mirrors them for affordance only and is never the thing enforcing them.
 */

const log = childLogger({ module: "server/locations" });

export async function createLocationAction(formData: FormData): Promise<ActionResult> {
  const parsed = parseCreateLocation(formData);

  if (!parsed.success) {
    return invalidInput(parsed.error, parsed.error.issues[0]?.message ?? "Invalid input.");
  }

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        // Plan limits are checked against live rows inside the same tenant
        // transaction, so two concurrent creates cannot both slip past.
        await requireWithinLimit({ organizationId: actor.organizationId, tx }, "max_locations");

        const [row] = await tx
          .insert(schema.locations)
          .values({
            organizationId: actor.organizationId,
            name: parsed.data.name,
            address: parsed.data.address,
            category: parsed.data.category,
          })
          .returning({ id: schema.locations.id });

        if (!row) throw new Error("Could not create the location.");

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "location.created",
          entity: `location:${row.id}`,
          meta: { name: parsed.data.name },
        });
      },
      { minimumRole: "admin" },
    );

    /**
     * The new branch does **not** become the one you are looking at (W4.3).
     *
     * It used to, and `docs/remediation-plan.md` calls it out by name. The
     * failure is quiet and happens at the worst moment: somebody with a running
     * business adds their second branch, and every screen they were working in
     * — Home, the queue, the weekly plan — silently switches to the empty one
     * they just created. Nothing looks broken. The numbers are simply gone, and
     * the obvious reading is that the product lost them.
     *
     * Adding a thing to a list is not the same act as going to look at it. The
     * switcher is one click away and it is the reader's call.
     */
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "createLocation failed");
    return toActionResult(error);
  }
}

/**
 * Connects a source that needs no authorization handshake.
 *
 * That is the mock, and any credentialed provider currently running in mock
 * mode — connecting a mocked Google is how the whole pipeline gets exercised
 * before the real one is approved. A provider that is genuinely live has a
 * consent screen instead, and the UI sends people to /api/connect/{provider}
 * rather than here; refusing it explicitly keeps the two paths from blurring.
 *
 * The first sync runs inline rather than through the queue so the slice works
 * without a worker process, and so the user sees reviews the moment they
 * connect instead of staring at an empty Inbox.
 */
export async function connectSourceAction(input: {
  locationId: string;
  provider: string;
}): Promise<ActionResult> {
  const parsed = connectSourceSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid location.");

  const provider = input.provider;
  const descriptor = getProvider(provider);
  if (!descriptor) return { ok: false, error: `Unknown source "${provider}".` };

  const resolution = resolveMode(provider);
  if (resolution.mode === "off") {
    return { ok: false, error: `"${descriptor.label}" is switched off here.` };
  }

  /**
   * The same two exclusions the connect list applies (W1.4).
   *
   * Hiding a button is not a gate — the action is reachable by anyone who can
   * post to it, and it is what actually creates the row. `describeConnectableProviders`
   * decides what is *offered*; this decides what is *accepted*, and they have
   * to agree or the screen is decorative.
   *
   * The outbound case is the one that was reaching customers: connecting
   * WhatsApp here got as far as `syncConnection`, which threw
   * `Provider "whatsapp" cannot read reviews.` — a sentence written for
   * whoever wrote the connector, shown to whoever bought the product. The
   * refusal now happens before anything is created, and says what to do.
   */
  if (descriptor.capabilities.read === "none") {
    return {
      ok: false,
      error: `"${descriptor.label}" is a messaging channel, not a review source. Connect it under Messages.`,
    };
  }
  /**
   * The accept side of the same rule the pages apply, and it must read the
   * *same* input or the screen is decorative.
   *
   * It read `NODE_ENV === "production"` and the pages read
   * `ALLOW_DEV_CONNECTORS`; fixing only the pages made the button appear and
   * then be refused — which the browser suite caught immediately, because this
   * guard is doing exactly what W1.4 built it for.
   */
  if (descriptor.devOnly === true && !getEnv().ALLOW_DEV_CONNECTORS) {
    return { ok: false, error: `"${descriptor.label}" is not available here.` };
  }
  if (resolution.mode === "real" && descriptor.requiresOAuth) {
    return { ok: false, error: "This source needs authorization. Use the connect link instead." };
  }

  let organizationId = "";

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        organizationId = actor.organizationId;

        const [location] = await tx
          .select({ id: schema.locations.id })
          .from(schema.locations)
          .where(eq(schema.locations.id, parsed.data.locationId))
          .limit(1);

        // RLS already hides other tenants' locations; this turns a silent
        // no-op into a clear message.
        if (!location) throw new Error("That location does not exist.");

        const connection = await connectSource(tx, {
          organizationId: actor.organizationId,
          provider,
          config:
            provider === FIRST_PARTY_PROVIDER
              ? { locationId: parsed.data.locationId }
              : {
                  locationId: parsed.data.locationId,
                  backfillCount: 40,
                  dripIntervalMinutes: 60,
                },
        });

        const outcome = await syncConnectionWithin(tx, toConnection(connection));

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "connection.created",
          entity: `connection:${connection.id}`,
          meta: { provider, mode: resolution.mode, inserted: outcome.inserted },
        });
      },
      { minimumRole: "admin" },
    );

    // Analysis runs in the worker, not here: at free-tier pacing a 40-review
    // backfill takes minutes, and a server action must not hold a request open
    // for that. The Inbox shows the reviews immediately; insights fill in.
    await requestAnalysis(organizationId);
    await requestNotifications(organizationId);

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error, provider }, "connectSource failed");
    return toActionResult(error);
  }
}

/** Pulls any new reviews for one connection on demand. */
export async function syncNowAction(input: { connectionId: string }): Promise<ActionResult> {
  const parsed = syncNowSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid connection.");

  let organizationId = "";
  let changed = false;

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        organizationId = actor.organizationId;

        const [row] = await tx
          .select()
          .from(schema.connections)
          .where(eq(schema.connections.id, parsed.data.connectionId))
          .limit(1);

        if (!row) throw new Error("That connection does not exist.");
        if (row.organizationId !== actor.organizationId) {
          throw new Error("That connection does not exist.");
        }

        // An explicit "Sync now" ignores the polling interval, but still
        // claims a slot against the provider's shared budget.
        const outcome = await syncConnectionWithin(tx, toConnection(row), {
          ignoreSchedule: true,
        });

        changed = outcome.inserted + outcome.updated > 0;
      },
      { minimumRole: "member" },
    );

    if (changed) {
      await requestAnalysis(organizationId);
      await requestNotifications(organizationId);
    }

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "syncNow failed");
    return toActionResult(error);
  }
}

/**
 * Publish or unpublish a location's hosted review page (P3-T3).
 *
 * `admin`, and gated on `seo_pages` — its own key since P3-T7, set to match
 * `widgets` today because `docs/05` prices them as one line ("Widgets /
 * showcase"). The separate key exists so that pricing them apart is a config
 * edit rather than a code change, which is the whole point of T7.
 *
 * The weight of this action is worth naming: it is the moment a business's
 * reviews go onto an indexable page on our domain under their name. That is why
 * it is audit-logged with the resulting URL rather than a bare boolean — "who
 * put this on the internet, and what was the address" is the question anyone
 * asking about it later will actually have.
 */
export async function setPublicPageAction(input: {
  locationId: string;
  published: boolean;
}): Promise<ActionResult<{ slug?: string }>> {
  const parsed = z.object({ locationId: z.uuid(), published: z.boolean() }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid input.");

  try {
    const state = await withAuthenticatedTenant(
      async (tx, actor) => {
        const org = { organizationId: actor.organizationId, tx };
        await requireFeature(org, "seo_pages");

        const result = await setPublicPage(
          tx,
          actor.organizationId,
          parsed.data.locationId,
          parsed.data.published,
        );
        if (!result) throw new Error("That location does not exist.");

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: parsed.data.published ? "location.page_published" : "location.page_unpublished",
          entity: `location:${parsed.data.locationId}`,
          meta: { slug: result.slug },
        });

        return result;
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/locations");
    return { ok: true, slug: state.slug ?? undefined };
  } catch (error) {
    log.warn({ err: error }, "setPublicPage failed");
    return toActionResult(error);
  }
}
