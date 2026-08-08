import { eq } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";
import { MOCK_PROVIDER } from "../connectors/mock.ts";
import { connectSource, syncConnectionWithin, toConnection } from "../connectors/sync.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant } from "../lib/tenancy.ts";

/**
 * The sample workspace (W5-14, positioning win 1 in `docs/remediation-plan.md`).
 *
 * > **Demo workspace on first login** ("Explore with sample data" → a fully-
 * > populated Kadıköy café with a real digest) — value visible before the
 * > connect flow.
 *
 * The problem it solves is the shape of the first five minutes. Signing up
 * lands on an empty product that asks for a Google authorization before it has
 * shown anything, and the two features worth buying — the Action Digest and the
 * themes underneath it — need reviews to exist before they can say a word. So
 * the first thing a prospect sees is a form.
 *
 * ## It is a separate organization, and that is the design
 *
 * The obvious implementation is a flagged branch inside the person's real
 * workspace. It would put invented reviews in the same tenant as real ones, and
 * every average, every export, every digest and every widget would from then on
 * need to know about a flag — with a silent, plausible-looking failure whenever
 * one forgot. Migration 0050 records the same reasoning.
 *
 * A separate organization is held apart by RLS, which is the hardest boundary
 * the product has and the one thing here that cannot be forgotten. Membership
 * comes from BetterAuth exactly as it does for a real organization, so the
 * workspace switcher P4-T5 built already moves between them, and removing it is
 * one cascade.
 *
 * ## The reviews are the mock connector's, on purpose
 *
 * Not a fixture file, not rows written straight into `reviews`. The sample
 * workspace has a real `connections` row, a real sync, real `raw_payload`, real
 * dedup — so /connections, /locations and "Sync now" all show something true,
 * and the sample account exercises the same path a real one does. What is fake
 * is the platform at the far end, which is what "sample data" means and what
 * the banner says.
 */

const log = childLogger({ module: "onboarding/sample" });

/**
 * The café. Turkish, Istanbul, a single branch.
 *
 * A chain would show off the branch comparison and would misrepresent the
 * product to the audience this exists for: `docs/04` puts the launch market's
 * mass at single-location cafés and restaurants, and a demo that opens with
 * five branches tells that owner the product is not for them.
 */
export const SAMPLE_LOCATION = {
  name: "Moda Kahve",
  address: "Caferağa Mah., Moda Cad. 42, Kadıköy, İstanbul",
  category: "cafe",
} as const;

/**
 * How many reviews the sample café has.
 *
 * Sixty gives the digest themes worth naming, the rating trend a shape, and the
 * response-time distribution a tail — a demo with a dozen reviews shows off
 * nothing the product is sold on. It costs nothing in waiting: the first
 * briefing analyses only the week it briefs on (see
 * `onboarding/first-briefing.ts`), so the number here sets how rich the
 * *dashboard* looks, not how long the progress bar runs.
 *
 * The connector's drip is left off. A demo that keeps growing while you read it
 * is a demo whose numbers change between two screenshots.
 */
const SAMPLE_BACKFILL = 60;

/**
 * How far back those sixty reviews reach.
 *
 * Eight weeks, against the connector's 180-day default, and this is not
 * cosmetic. Sixty reviews over six months is two a week, and a two-review week
 * is below `MIN_ANALYSED_REVIEWS` — so the pipeline correctly declines to draw
 * a plan from it, and the demo's whole point opens on "Not enough to draw a
 * plan from". That is what the first run of this feature actually did.
 *
 * Eight weeks makes it seven or eight reviews a week, which is what a busy
 * neighbourhood café looks like, and every week in the demo has a real briefing
 * behind it. The threshold stays where W1.6 put it; the sample data stops
 * pretending a dormant business is a good advertisement.
 */
const SAMPLE_SPAN_DAYS = 56;

export type SampleWorkspace = { organizationId: string; locationId: string };

/**
 * Builds the sample workspace's contents inside an organization that already
 * exists.
 *
 * Split from creating the organization because the two need different
 * privileges: creating one is BetterAuth's job through the request's own
 * session, and this runs under `withTenant` like every other tenant write.
 *
 * Idempotent. Pressing the button twice — or a retry after a half-finished
 * attempt — converges rather than producing a second café: the location is
 * matched by name, and `connectSource` already upserts on
 * `(location, provider)`.
 */
export async function fillSampleWorkspace(
  organizationId: string,
  locale = "tr",
): Promise<SampleWorkspace> {
  const locationId = await withTenant({ organizationId }, async (tx) => {
    const existing = await tx
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(eq(schema.locations.organizationId, organizationId))
      .limit(1);

    if (existing[0]) return existing[0].id;

    const [created] = await tx
      .insert(schema.locations)
      .values({
        organizationId,
        name: SAMPLE_LOCATION.name,
        address: SAMPLE_LOCATION.address,
        category: SAMPLE_LOCATION.category,
        // The briefing is written in the location's language; see the caller.
        locale,
      })
      .returning({ id: schema.locations.id });

    if (!created) throw new Error("Could not create the sample location.");
    return created.id;
  });

  await withTenant({ organizationId }, async (tx) => {
    /**
     * The mock connector, and the `devOnly` gate is deliberately not consulted.
     *
     * `connectSourceAction` refuses a dev-only provider outside development,
     * and rightly: connecting a fake source to a *real* business would put
     * invented reviews under their name. That risk does not exist here — this
     * organization was created by this function moments ago with
     * `is_sample = true`, and can hold nothing else. The gate is about which
     * organization, not about which environment, and this is the one place
     * where the answer is known rather than guessed.
     */
    const connection = await connectSource(tx, {
      organizationId,
      provider: MOCK_PROVIDER,
      config: {
        locationId,
        backfillCount: SAMPLE_BACKFILL,
        spanDays: SAMPLE_SPAN_DAYS,
        // No drip: see SAMPLE_BACKFILL.
        dripIntervalMinutes: null,
      },
    });

    // Inline rather than queued, like the connect flow's first sync: the reviews
    // have to be there when the welcome screen renders, and the "platform" is a
    // generator in this process.
    const outcome = await syncConnectionWithin(tx, toConnection(connection));
    log.info({ organizationId, inserted: outcome.inserted }, "Sample workspace filled");
  });

  return { organizationId, locationId };
}

/** Marks an organization as the sample one. Owner connection: no session yet. */
export async function markSample(organizationId: string): Promise<void> {
  await getAdminDb()
    .update(schema.organizations)
    .set({ isSample: true, updatedAt: new Date() })
    .where(eq(schema.organizations.id, organizationId));
}

/** Whether an organization is the sample one. */
export async function isSampleOrganization(organizationId: string): Promise<boolean> {
  const [row] = await getAdminDb()
    .select({ isSample: schema.organizations.isSample })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  return row?.isSample ?? false;
}
