import { and, eq } from "drizzle-orm";
import { withAuthenticatedTenant } from "@/auth/session";
import { schema } from "@/db/client";
import { parseRange, rangeWindow } from "@/dashboard/range";
import { getLocale } from "@/i18n/locale";
import { csvFilename } from "@/analytics/csv";
import { buildExport, isExportKind } from "@/analytics/export";
import { loadInsightFacts } from "@/analytics/facts";
import { EntitlementError, requireFeature } from "@/lib/entitlements";
import { childLogger } from "@/lib/logger";
import { ANALYZE_PROMPT_ID } from "@/prompts";
import { reportCopy } from "@/reports/copy";
import { renderReportPdf } from "@/reports/document";
import { composeReport } from "@/reports/pipeline";
import { resolveLocationScope, withinScope } from "@/auth/scope";

/**
 * `GET /insights/export?format=…&kind=…&range=…` (P3-T4, PDF added in T5).
 *
 * Authenticated, gated and scoped exactly as the page is: the same entitlement,
 * the same tenant transaction, the same location scope, the same facts loader. That matters
 * more than it looks — an export route is a quiet way to hand somebody data the
 * screen would not show them, and a manager limited to one branch must not be
 * able to download the whole chain by editing a query string. **There is no
 * `locationId` parameter here and there must not be one**; the scope comes from
 * the member.
 *
 * Two formats, one set of numbers:
 *
 *   - **CSV** for arithmetic — raw values, no locale formatting, one file per
 *     section or one long table with everything in it.
 *   - **PDF** for reading, and it is deliberately the *same document* the
 *     scheduled report mails (`composeReport` + `renderReportPdf`). A download
 *     that looked different from the thing arriving by email every Monday
 *     would make both look unreliable.
 *
 * Every parameter falls back rather than failing. A download link is the kind
 * of URL people share and edit, and a 400 in a downloaded file is a worse
 * answer than the default view of the same data.
 */

const log = childLogger({ module: "insights/export" });

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const format = params.get("format") === "pdf" ? "pdf" : "csv";
  const kindParam = params.get("kind") ?? "";
  const kind = isExportKind(kindParam) ? kindParam : "everything";
  const range = parseRange(params.get("range") ?? undefined);
  const window = rangeWindow(range, new Date());

  try {
    const data = await withAuthenticatedTenant(async (tx, actor) => {
      // The same gate as the page. An export route that answered when the
      // screen would not is a way to read a paid feature by URL — and it is
      // exactly the sort of route nobody remembers to check.
      await requireFeature({ organizationId: actor.organizationId, tx }, "analytics");

      // The member's own scope, read here rather than through
      // `lib/active-location.ts` so this route and the worker's pipeline agree
      // on what "visible" means without either importing the other's world.
      const scope = await resolveLocationScope(tx, actor.organizationId, actor.userId, actor.role);
      const all = await tx
        .select({ id: schema.locations.id, name: schema.locations.name })
        .from(schema.locations)
        .where(eq(schema.locations.organizationId, actor.organizationId));

      const locations = all.filter((location) => withinScope(scope, location.id));

      const [organization] = await tx
        .select({ name: schema.organizations.name })
        .from(schema.organizations)
        .where(and(eq(schema.organizations.id, actor.organizationId)))
        .limit(1);

      return {
        organizationName: organization?.name ?? "",
        locations,
        facts: await loadInsightFacts(
          tx,
          actor.organizationId,
          locations.map((location) => location.id),
          window,
          ANALYZE_PROMPT_ID,
        ),
      };
    });

    const names = new Map(data.locations.map((location) => [location.id, location.name]));
    const locationName = (id: string) => names.get(id) ?? id;

    if (format === "pdf") {
      // The viewer's language, unlike the scheduled report's — that one uses
      // the recipient's stored locale because a worker has no request; this is
      // a request, and the person is looking at the page in some language.
      const locale = await getLocale();
      const composed = composeReport(data.facts, {
        locale,
        title: data.organizationName,
        // The selected range, expressed as the period shape the report takes.
        period: { start: window.start, end: window.end, previous: window.previous },
        // A range is not a cadence. "weekly" reads as a claim about a schedule
        // this download does not have, so the subtitle names the range instead.
        cadence: window.days > 30 ? "monthly" : "weekly",
        locationName,
        generatedAt: new Date(),
      });

      const pdf = await renderReportPdf(composed.content);
      const filename = reportCopy(locale).filename(data.organizationName || "insights", new Date());

      return new Response(new Uint8Array(pdf), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return new Response(buildExport(kind, data.facts, window, locationName), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFilename(kind, range, new Date())}"`,
        // A business's own numbers, and a shared CDN has no business holding a
        // copy of them.
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    // "Not on your plan" is not a server failure, and a 500 would send somebody
    // looking for an outage that is not there. The body stays empty either way:
    // this is a download, and a stack trace in a saved file helps nobody.
    if (error instanceof EntitlementError) {
      return new Response("", { status: 403 });
    }

    log.warn({ err: error, format, kind }, "Insights export failed");
    return new Response("", { status: 500 });
  }
}
