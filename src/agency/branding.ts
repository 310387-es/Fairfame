import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getAdminDb, schema } from "../db/client.ts";
import { PLAN_CATALOG, parseOverrides, applyOverrides, DEFAULT_PLAN_KEY } from "../lib/plans.ts";
import { publicBaseUrl } from "../lib/urls.ts";

/**
 * Whose name a public page carries (P4-T5).
 *
 * **This is what white-label actually means**, and it is one rule: a client
 * organization's customer-facing pages carry *its agency's* brand, not ours and
 * not the client's — because the agency is who the client's customers have
 * heard of, and the agency is who is being paid to look like the software.
 *
 * The resolution order is therefore:
 *
 *   1. The **agency's** brand, if this organization has one *and* that agency's
 *      plan includes `white_label`.
 *   2. The organization's **own** brand. Not a white-label feature — an
 *      ordinary business putting its logo on its own review page is just having
 *      a logo, and gating that behind the Agency tier would be mean.
 *   3. Revira.
 *
 * **The entitlement is checked on the agency, not on the client.** It is the
 * agency that bought the right to put its name on somebody else's page; a
 * client on the Starter plan whose agency pays for Agency still gets the
 * agency's branding, because the agency is the customer.
 *
 * Cross-organization by necessity — a client's page has to read its agency's
 * row — so this is one of the two deliberate cross-tenant reads in the product
 * (the other is `sitemap.xml`). It is confined to this file, it reads a
 * **fixed, tiny projection** (name, logo, colour) and never a review, a
 * contact, or anything else a tenant owns, and no caller supplies an
 * organization id it did not already resolve from a public key.
 */

/** The parts of a brand that are not the logo. Tolerant: a bad blob is no brand. */
const brandingSchema = z
  .object({
    primaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    senderName: z.string().max(80).optional(),
    /** Whether "Powered by Revira" appears. Only an agency may switch it off. */
    hidePoweredBy: z.boolean().optional(),
  })
  .partial();

export type BrandingInput = z.infer<typeof brandingSchema>;

export function parseBranding(value: unknown): BrandingInput {
  const parsed = brandingSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

export type Brand = {
  /** Whose name is on the page. */
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  /** The origin its public links are built from. */
  baseUrl: string;
  /** False only when an agency with `white_label` has switched it off. */
  showPoweredBy: boolean;
  /** True when the brand came from an agency rather than the organization. */
  whiteLabelled: boolean;
};

/** What every unbranded page has always shown. */
export const DEFAULT_BRAND: Omit<Brand, "baseUrl"> = {
  name: "Revira",
  logoUrl: null,
  primaryColor: null,
  showPoweredBy: true,
  whiteLabelled: false,
};

type OrgRow = {
  id: string;
  name: string;
  logo: string | null;
  branding: unknown;
  customDomain: string | null;
};

/**
 * Does this organization's plan include white-label?
 *
 * Resolved here from the plan catalog rather than through `can()`, because
 * `can()` opens a tenant transaction and this runs on a public page that has
 * already resolved its tenant from a key. The values are the same ones
 * `resolveEntitlements` reads — `PLAN_CATALOG` is the single source either way.
 */
async function hasWhiteLabel(organizationId: string): Promise<boolean> {
  const [row] = await getAdminDb()
    .select({
      planKey: schema.plans.key,
      status: schema.subscriptions.status,
      currentPeriodEnd: schema.subscriptions.currentPeriodEnd,
      overrides: schema.subscriptions.overrides,
    })
    .from(schema.subscriptions)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
    .where(eq(schema.subscriptions.organizationId, organizationId))
    .limit(1);

  if (!row) return false;

  // A lapsed or cancelled agency loses the right to brand somebody else's page,
  // and the page falls back to the client's own name rather than going blank.
  const live =
    row.status === "active" ||
    row.status === "past_due" ||
    (row.status === "trialing" &&
      (row.currentPeriodEnd === null || row.currentPeriodEnd.getTime() > Date.now()));

  if (!live) return false;

  const plan = PLAN_CATALOG[row.status === "trialing" ? "agency" : row.planKey];
  const entitlements = applyOverrides(
    plan?.entitlements ?? PLAN_CATALOG[DEFAULT_PLAN_KEY].entitlements,
    parseOverrides(row.overrides),
  );

  return entitlements.features.white_label;
}

function toBrand(row: OrgRow, whiteLabelled: boolean, allowHidePoweredBy: boolean): Brand {
  const branding = parseBranding(row.branding);

  return {
    name: branding.senderName?.trim() || row.name,
    logoUrl: row.logo,
    primaryColor: branding.primaryColor ?? null,
    baseUrl: row.customDomain ? `https://${row.customDomain}` : publicBaseUrl(),
    // Only an agency that pays for white-label may remove our mark. A client
    // switching it off in its own settings would be getting the feature it did
    // not buy, one checkbox at a time.
    showPoweredBy: allowHidePoweredBy ? branding.hidePoweredBy !== true : true,
    whiteLabelled,
  };
}

/**
 * The brand a public page for this organization should wear.
 *
 * Never throws and never blocks a page: a missing row, a malformed blob or a
 * lapsed subscription all degrade to the next rule down and eventually to
 * Revira. A customer looking at a review page must not see an error because an
 * agency mistyped a colour.
 */
export async function resolveBrand(organizationId: string): Promise<Brand> {
  const db = getAdminDb();

  const [link] = await db
    .select({ agencyId: schema.agencyClients.organizationId })
    .from(schema.agencyClients)
    .where(eq(schema.agencyClients.clientOrganizationId, organizationId))
    .limit(1);

  const ids = link ? [organizationId, link.agencyId] : [organizationId];

  const rows = await db
    .select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      logo: schema.organizations.logo,
      branding: schema.organizations.branding,
      customDomain: schema.organizations.customDomain,
    })
    .from(schema.organizations)
    .where(inArray(schema.organizations.id, ids));

  const own = rows.find((row) => row.id === organizationId);
  const agency = link ? rows.find((row) => row.id === link.agencyId) : undefined;

  if (agency && (await hasWhiteLabel(agency.id))) {
    return toBrand(agency, true, true);
  }

  // Its own brand, or ours. `allowHidePoweredBy` is false here on purpose —
  // see the note in `toBrand`.
  return own ? toBrand(own, false, false) : { ...DEFAULT_BRAND, baseUrl: publicBaseUrl() };
}

/**
 * The origin a client's public links should use.
 *
 * **Storing a custom domain is not serving one.** DNS and a certificate are
 * infrastructure this application cannot provision, so a domain set here changes
 * the URLs we *print* and nothing about what answers them. Until the go-live
 * step in `docs/13` is done, setting one on an organization whose DNS does not
 * point at us produces links that do not resolve — which is why the settings
 * screen says so rather than presenting it as a finished feature.
 */
export function brandedBaseUrl(brand: Brand): string {
  return brand.baseUrl;
}
