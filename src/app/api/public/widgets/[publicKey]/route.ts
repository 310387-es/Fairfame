import { childLogger } from "@/lib/logger";
import {
  allowPublicRead,
  cacheableResponse,
  corsHeaders,
  NO_CACHE,
  notFoundResponse,
  preflight,
  rateLimitedResponse,
} from "@/widgets/http";
import { loadWidgetContent, resolveWidgetByKey } from "@/widgets/public";

/**
 * The public widget read: `GET /api/public/widgets/{publicKey}`.
 *
 * Unauthenticated, cross-origin, CDN-cacheable, and the endpoint `CLAUDE.md`'s
 * public surface rule is written about. It is also the documented shape for
 * anyone who wants to render their reviews themselves rather than use our embed
 * — which is why it returns data rather than markup.
 *
 * There is exactly one input: the key in the path. No query parameter widens
 * the result set, chooses a location, or relaxes the approval gate, because a
 * public endpoint whose scope can be argued with is a public endpoint that will
 * eventually be argued with successfully.
 */

const log = childLogger({ module: "api/public/widgets" });

type RouteContext = { params: Promise<{ publicKey: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { publicKey } = await context.params;

  if (!(await allowPublicRead(request))) return rateLimitedResponse();

  try {
    const widget = await resolveWidgetByKey(publicKey);

    // Unknown, malformed and unpublished are one answer. See notFoundResponse.
    if (!widget || !widget.published) return notFoundResponse();

    const content = await loadWidgetContent(widget);

    const body = JSON.stringify({
      widget: {
        name: widget.name,
        locale: widget.locale,
        layout: widget.style.layout,
        theme: widget.style.theme,
      },
      business: {
        name: widget.organizationName,
        // Null for an organization-wide widget, which is the honest answer:
        // these reviews are not from one place.
        location: widget.locationName,
      },
      aggregate: content.aggregate,
      reviews: content.reviews,
    });

    return cacheableResponse(request, body, "application/json; charset=utf-8");
  } catch (error) {
    // The stack goes to the logs. A public endpoint that describes its own
    // failure is telling a stranger about our schema.
    log.error({ err: error }, "Public widget read failed");
    return new Response(JSON.stringify({ error: "server_error" }), {
      status: 500,
      headers: corsHeaders({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": NO_CACHE,
      }),
    });
  }
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
