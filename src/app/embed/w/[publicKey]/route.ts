import { childLogger } from "@/lib/logger";
import {
  allowPublicRead,
  cacheableResponse,
  corsHeaders,
  NO_CACHE,
  notFoundResponse,
  rateLimitedResponse,
} from "@/widgets/http";
import { widgetContentSecurityPolicy } from "@/widgets/csp";
import { widgetLabels } from "@/widgets/labels";
import { renderWidgetDocument } from "@/widgets/markup";
import { loadWidgetContent, resolveWidgetByKey } from "@/widgets/public";

/**
 * The widget as a standalone document: `GET /embed/w/{publicKey}`.
 *
 * This is what the loader script mounts in an iframe, and it is also a complete
 * embed on its own — a customer who does not want to run our JavaScript can
 * paste a plain `<iframe>` at this URL and get the same widget. That is the
 * "iframe fallback" in `docs/19` P3-T0, and it is a real fallback rather than a
 * degraded one, because **it is the only renderer**: the script does not draw
 * anything, so there is no second implementation to drift.
 *
 * A route handler rather than a page, deliberately. The output is a static
 * document built from a JSON payload; React would add a hydration runtime to
 * somebody else's page load in exchange for nothing.
 */

const log = childLogger({ module: "embed/widget-document" });

type RouteContext = { params: Promise<{ publicKey: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { publicKey } = await context.params;

  if (!(await allowPublicRead(request))) return rateLimitedResponse();

  const html = "text/html; charset=utf-8";

  try {
    const widget = await resolveWidgetByKey(publicKey);
    if (!widget || !widget.published) return notFoundResponse(html);

    const [content, labels] = await Promise.all([
      loadWidgetContent(widget),
      widgetLabels(widget.locale),
    ]);

    const document = renderWidgetDocument(content, labels);
    const response = cacheableResponse(request, document, html);

    // Derived from the document, not from the constants it was built out of, so
    // the two cannot drift. See src/widgets/csp.ts.
    response.headers.set("Content-Security-Policy", widgetContentSecurityPolicy(document));
    // A stale sniff would let a customer's proxy decide this is something else.
    response.headers.set("X-Content-Type-Options", "nosniff");
    // The referrer of a widget request would name the customer's page. Their
    // traffic is not ours to log.
    response.headers.set("Referrer-Policy", "no-referrer");

    return response;
  } catch (error) {
    log.error({ err: error }, "Widget document render failed");
    return new Response("", {
      status: 500,
      headers: corsHeaders({ "Content-Type": html, "Cache-Control": NO_CACHE }),
    });
  }
}
