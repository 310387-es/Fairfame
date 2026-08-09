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
import { businessHoursSchema } from "@/locations/opening-hours";
import { MAX_BRAND_TONE_CHARS } from "@/prompts/index";
import { refreshSlaDueAt } from "@/reviews/workflow";
import { MAX_SIGNATURE_CHARS } from "@/replies/style";
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
}): Promise<ActionResult<{ next?: string }>> {
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
  let firstSource = false;

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        organizationId = actor.organizationId;

        // Asked before the insert, so "first" means before this one.
        const [prior] = await tx
          .select({ id: schema.connections.id })
          .from(schema.connections)
          .where(eq(schema.connections.organizationId, actor.organizationId))
          .limit(1);
        firstSource = prior === undefined;

        const [location] = await tx
          .select({ id: schema.locations.id, category: schema.locations.category })
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
                  // So a café's demo is about coffee (A22-C7). Copied in here
                  // rather than read at fetch time, because the mock's contract
                  // is that its output is a pure function of its config — see
                  // `mockConfigSchema`.
                  vertical: location.category,
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
    /**
     * The first source is the digest-first moment (positioning win 2).
     *
     * `docs/remediation-plan.md`: "connect Google → run analysis → compose a
     * digest immediately over the backfill → land the user on it. Not 'wait a
     * week.'" Until now the answer to "what happens after I connect" was an
     * Inbox and a seven-day wait for the screen the product is sold on.
     *
     * Only on the **first** source. Somebody adding Instagram to a working
     * account has read plenty of briefings and does not need to be sent to a
     * progress bar; `firstSource` is decided inside the transaction, before the
     * new row exists, so it means what it says.
     */
    return firstSource ? { ok: true, next: "/welcome" } : { ok: true };
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

/**
 * The branch's voice: how its replies sound, and how they are signed (W5-12).
 *
 * Both fields have always existed in the prompt path and neither has ever had a
 * control — `brand_tone` has been read by `draftReplyForReview` since P1a-T6
 * with no way to set it, which is the same as not having the feature. A column
 * nothing writes is the `competitor_snapshots` mistake in the other direction.
 *
 * Admin, because these two strings appear on every public reply that branch
 * sends, under the business's name.
 *
 * Empty means unset, not empty-string: the prompt falls back to a neutral
 * default for a null tone, and a signature of `""` would otherwise start
 * appending two blank lines to every draft.
 */
export async function setLocationVoiceAction(input: {
  locationId: string;
  brandTone: string;
  replySignature: string;
}): Promise<ActionResult> {
  const parsed = z
    .object({
      locationId: z.uuid(),
      brandTone: z.string().trim().max(MAX_BRAND_TONE_CHARS),
      replySignature: z.string().trim().max(MAX_SIGNATURE_CHARS),
    })
    .safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "That is longer than we can use.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        const [row] = await tx
          .update(schema.locations)
          .set({
            brandTone: parsed.data.brandTone.length > 0 ? parsed.data.brandTone : null,
            replySignature:
              parsed.data.replySignature.length > 0 ? parsed.data.replySignature : null,
            updatedAt: new Date(),
          })
          .where(eq(schema.locations.id, parsed.data.locationId))
          .returning({ id: schema.locations.id });

        // RLS scopes the UPDATE to this tenant, so an empty result is "no such
        // branch here" rather than a permission failure.
        if (!row) throw new Error("That location does not exist.");

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "location.voice_updated",
          entity: `location:${parsed.data.locationId}`,
          // The values themselves, because "who changed how our replies sign
          // off" is answerable only if the log says what it changed to. Both
          // are business copy the owner wrote, not personal data.
          meta: {
            brandTone: parsed.data.brandTone || null,
            replySignature: parsed.data.replySignature || null,
          },
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/locations");
    revalidatePath("/reviews");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "setLocationVoice failed");
    return toActionResult(error);
  }
}

/**
 * Switches this branch's auto-reply rule on or off (W5-6).
 *
 * `templateId` null is off, and that is the whole switch — one column, so there
 * is no boolean that could disagree with it.
 *
 * Admin, because this is the only setting in the product that puts words on a
 * public platform without anybody pressing anything afterwards. The template
 * has to belong to this organization, and that is checked here rather than
 * relied on from RLS alone: the failure would be silent, and a foreign key
 * violation is a worse error message than a sentence.
 */
export async function setAutoReplyAction(input: {
  locationId: string;
  templateId: string | null;
  delayHours: number;
}): Promise<ActionResult> {
  const parsed = z
    .object({
      locationId: z.uuid(),
      templateId: z.uuid().nullable(),
      // One hour to a fortnight. The lower bound is the point: "immediately"
      // would remove the window a person has to answer it themselves, which is
      // the thing that makes this reversible without a support ticket.
      delayHours: z.number().int().min(1).max(336),
    })
    .safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid auto-reply settings.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        if (parsed.data.templateId) {
          const [template] = await tx
            .select({ id: schema.replyTemplates.id })
            .from(schema.replyTemplates)
            .where(eq(schema.replyTemplates.id, parsed.data.templateId))
            .limit(1);
          if (!template) throw new Error("That template no longer exists.");
        }

        const [row] = await tx
          .update(schema.locations)
          .set({
            autoReplyTemplateId: parsed.data.templateId,
            autoReplyDelayHours: parsed.data.delayHours,
            updatedAt: new Date(),
          })
          .where(eq(schema.locations.id, parsed.data.locationId))
          .returning({ id: schema.locations.id });

        if (!row) throw new Error("That location does not exist.");

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: parsed.data.templateId ? "location.auto_reply_on" : "location.auto_reply_off",
          entity: `location:${parsed.data.locationId}`,
          meta: { templateId: parsed.data.templateId, delayHours: parsed.data.delayHours },
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/locations");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "setAutoReply failed");
    return toActionResult(error);
  }
}

/**
 * Sets a branch's opening hours, and re-dates its open reviews (W5-8).
 *
 * The second half is the point. `refreshPriority` deliberately never touches
 * `sla_due_at`, so without this the queue would keep every deadline it had
 * computed against a round-the-clock clock — and the overdue filter would go on
 * showing the Saturday breaches this feature exists to stop.
 *
 * Empty (all seven days closed) clears the calendar rather than storing a week
 * nobody is open: `parseBusinessHours` reads that as "no hours", which is the
 * unchanged behaviour, and storing it would be a schedule whose deadline never
 * arrives.
 */
export async function setBusinessHoursAction(input: {
  locationId: string;
  /** Seven entries, Sunday first — `Date.getUTCDay()`'s order. */
  hours: ({ open: string; close: string } | null)[];
}): Promise<ActionResult<{ rescored: number }>> {
  const parsed = z.object({ locationId: z.uuid(), hours: businessHoursSchema }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Those opening hours are not valid.");

  const anyOpen = parsed.data.hours.some((day) => day !== null);

  try {
    const rescored = await withAuthenticatedTenant(
      async (tx, actor) => {
        const [row] = await tx
          .update(schema.locations)
          .set({ businessHours: anyOpen ? parsed.data.hours : null, updatedAt: new Date() })
          .where(eq(schema.locations.id, parsed.data.locationId))
          .returning({ id: schema.locations.id });

        if (!row) throw new Error("That location does not exist.");

        await tx.insert(schema.auditLogs).values({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: anyOpen ? "location.hours_set" : "location.hours_cleared",
          entity: `location:${parsed.data.locationId}`,
          meta: { hours: anyOpen ? parsed.data.hours : null },
        });

        return refreshSlaDueAt(tx, actor.organizationId, parsed.data.locationId);
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/locations");
    revalidatePath("/reviews");
    return { ok: true, rescored };
  } catch (error) {
    log.warn({ err: error }, "setBusinessHours failed");
    return toActionResult(error);
  }
}
