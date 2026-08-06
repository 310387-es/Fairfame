import { eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { withAuthenticatedTenant } from "@/auth/session";
import { resolveLocationScope, withinScope } from "@/auth/scope";
import { renderPoster, type PosterLayout } from "@/collect/poster";
import { schema } from "@/db/client";
import { childLogger } from "@/lib/logger";
import { campaignUrl } from "@/lib/urls";

/**
 * `GET /get-reviews/poster?campaign=…&layout=poster|tent` (W4.5).
 *
 * **Scoped like the screen it is reached from.** A campaign belongs to a
 * branch, and a member pinned to one branch must not be able to print another
 * branch's code by editing a query string — the same rule the Insights export
 * route records, and the same reason there is no `locationId` parameter to
 * override.
 *
 * **Not gated by an entitlement, deliberately.** The QR code itself is already
 * on the screen for every plan; this only arranges it on a page. Charging for
 * the arrangement of something already given away would be the kind of gate
 * that reads as petty, and `docs/05` prices collection by *volume* — the
 * `requests_per_month` allowance — rather than by surface.
 *
 * A `Content-Disposition: attachment` with a real filename, because the thing
 * somebody does next is print it: landing in a browser tab called
 * "route" is one extra step at exactly the moment the feature is meant to
 * disappear into the background.
 */

const log = childLogger({ module: "collect/poster" });

const LAYOUTS: PosterLayout[] = ["poster", "tent"];

/** Latin-1 safe, so `Content-Disposition` cannot be broken by a branch name. */
function asciiFilename(value: string): string {
  return (
    value
      .normalize("NFKD")
      // Turkish letters do not decompose (`ı`, `ş`, `ğ` survive NFKD), which is
      // the trap `src/seo/slug.ts` documents; map them before stripping.
      .replace(/[ıİ]/g, "i")
      .replace(/[şŞ]/g, "s")
      .replace(/[ğĞ]/g, "g")
      .replace(/[çÇ]/g, "c")
      .replace(/[öÖ]/g, "o")
      .replace(/[üÜ]/g, "u")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "qr"
  );
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const campaignId = params.get("campaign") ?? "";
  const requested = params.get("layout") ?? "poster";
  const layout: PosterLayout = LAYOUTS.includes(requested as PosterLayout)
    ? (requested as PosterLayout)
    : "poster";

  try {
    const found = await withAuthenticatedTenant(
      async (tx, actor) => {
        const [row] = await tx
          .select({
            slug: schema.campaigns.slug,
            locationId: schema.campaigns.locationId,
            branchName: schema.locations.name,
            businessName: schema.organizations.name,
          })
          .from(schema.campaigns)
          .innerJoin(schema.locations, eq(schema.locations.id, schema.campaigns.locationId))
          .innerJoin(
            schema.organizations,
            eq(schema.organizations.id, schema.campaigns.organizationId),
          )
          .where(eq(schema.campaigns.id, campaignId))
          .limit(1);

        if (!row) return null;

        const scope = await resolveLocationScope(
          tx,
          actor.organizationId,
          actor.userId,
          actor.role,
        );
        if (!withinScope(scope, row.locationId)) return null;

        // How many branches this member can see, so a single-location account
        // does not get a poster naming a branch nobody distinguishes.
        const branches = await tx
          .select({ id: schema.locations.id })
          .from(schema.locations)
          .where(eq(schema.locations.organizationId, actor.organizationId));

        return { ...row, several: branches.length > 1 };
      },
      { minimumRole: "member" },
    );

    if (!found) return new Response("Not found", { status: 404 });

    const t = await getTranslations("requests.poster");
    const url = campaignUrl(found.slug);

    const pdf = await renderPoster({
      layout,
      businessName: found.businessName,
      branchName: found.several ? found.branchName : null,
      url,
      headline: t("headline"),
      subhead: t("subhead"),
      urlLabel: t("urlLabel"),
      foldLabel: t("foldLabel"),
    });

    const name = `${asciiFilename(found.businessName)}-${layout === "tent" ? "masa" : "poster"}.pdf`;

    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${name}"`,
        // A poster is generated from data that can change (the branch was
        // renamed, the campaign re-slugged); nothing here is worth a stale copy.
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    log.warn({ err: error, campaignId }, "poster render failed");
    return new Response("Could not render the poster.", { status: 500 });
  }
}
