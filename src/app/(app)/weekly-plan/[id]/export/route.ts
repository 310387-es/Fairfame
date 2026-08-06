import { and, eq } from "drizzle-orm";
import { getFormatter, getTranslations } from "next-intl/server";
import {
  NoActiveOrganizationError,
  UnauthenticatedError,
  withAuthenticatedTenant,
} from "@/auth/session";
import { schema } from "@/db/client";
import { renderDigestPdf } from "@/digest/pdf";
import { digestById } from "@/digest/queries";
import { digestPdfContent } from "@/digest/share";
import { toShareableDigest } from "@/digest/shareable";
import { childLogger } from "@/lib/logger";
import { slugify } from "@/seo/slug";

/**
 * `GET /digest/{id}/export` — the week as a PDF (W2.1).
 *
 * **Authenticated and tenant-scoped exactly as the page is**, through the same
 * `digestById`: an id from another organization is indistinguishable from one
 * that does not exist, which is the correct answer to both. An export route is
 * a quiet way to hand somebody a document the screen would not show them, and
 * it is exactly the kind of route nobody remembers to check — `docs/19` records
 * the same reasoning for `/analytics/export`.
 *
 * **Deliberately not entitlement-gated.** `/analytics/export` is behind
 * `analytics` because the Insights workspace itself is; the digest is core to
 * every plan, so gating a download of a page the reader is already looking at
 * would be a paywall in front of a door that is open. `scheduled_reports` gates
 * something different — having a document *arrive by itself*, every week,
 * without anybody opening the app.
 *
 * The filename carries the branch and the week, because a folder of files all
 * called `digest.pdf` is a folder of files nobody can tell apart.
 */

const log = childLogger({ module: "digest/export" });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  try {
    const prepared = await withAuthenticatedTenant(async (tx, actor) => {
      const digest = await digestById(tx, actor.organizationId, id);
      if (!digest) return null;

      // Read here rather than added to `DigestView`: the branch name is what a
      // *printed* briefing needs on its cover, and every other reader of that
      // type already knows which location it is looking at. Sequential, because
      // one tenant transaction is one `pg` client (P4-T1).
      const [location] = await tx
        .select({ name: schema.locations.name })
        .from(schema.locations)
        .where(
          and(
            eq(schema.locations.organizationId, actor.organizationId),
            eq(schema.locations.id, digest.locationId),
          ),
        )
        .limit(1);

      const [t, format] = await Promise.all([getTranslations("digest"), getFormatter()]);

      // The exclusive end printed as the day before, so a seven-day week does
      // not read as eight — the same correction the email and the page make.
      const inclusiveEnd = new Date(digest.periodEnd.getTime() - 1);
      const period = `${format.dateTime(digest.periodStart, {
        day: "numeric",
        month: "long",
      })} – ${format.dateTime(inclusiveEnd, { day: "numeric", month: "long", year: "numeric" })}`;

      const shareable = toShareableDigest({
        digest,
        scopeName: location?.name ?? "",
        period,
        t,
        format: {
          number: (value, maximumFractionDigits) => format.number(value, { maximumFractionDigits }),
        },
      });

      return { shareable, periodStart: digest.periodStart, name: location?.name ?? "digest" };
    });

    if (!prepared) return new Response("Not found", { status: 404 });

    const pdf = await renderDigestPdf(digestPdfContent(prepared.shareable));
    // The Turkish-aware slugifier, not a naive `[^a-z0-9]` strip: that turns
    // "Kadıköy Şubesi" into "kad-k-y-ubesi", because `ı`, `İ`, `ş` and `ğ` do
    // not survive the usual NFD recipe (P3-T3).
    const slug = slugify(prepared.name);
    const week = prepared.periodStart.toISOString().slice(0, 10);

    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${slug || "digest"}-${week}.pdf"`,
        // A briefing is per-person and per-week; a shared cache holding one is
        // a shared cache holding somebody's business data.
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    // Not signed in is a 401, not a server failure. A 500 here would send
    // somebody looking for an outage that is not there — the same correction
    // `/analytics/export` makes for an unentitled caller. There is no
    // entitlement branch to mirror because this route has no gate; see above.
    if (error instanceof UnauthenticatedError || error instanceof NoActiveOrganizationError) {
      return new Response("", { status: 401 });
    }

    log.warn({ err: error, digestId: id }, "Digest export failed");
    return new Response("", { status: 500 });
  }
}
