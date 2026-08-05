import { withAuthenticatedTenant } from "@/auth/session";
import { childLogger } from "@/lib/logger";
import { widgetConfigFromParams } from "@/widgets/config";
import { widgetContentSecurityPolicy } from "@/widgets/csp";
import { widgetLabels } from "@/widgets/labels";
import { renderWidgetDocument } from "@/widgets/markup";
import { loadWidgetContent, resolveWidgetByKey, type PublicWidget } from "@/widgets/public";
import { getWidget } from "@/widgets/store";
import { isLocale, type Locale } from "@/i18n/config";

/**
 * The builder's live preview: `GET /widgets/{id}/preview?layout=…&theme=…`.
 *
 * **Authenticated, and deliberately a separate route from the public one.** The
 * public endpoint refuses an unpublished widget, which is correct — but a
 * builder whose preview only worked after publishing would make "see it, then
 * decide" impossible. So the preview is behind a session, scoped by RLS to the
 * signed-in organization, and shows a draft.
 *
 * The unsaved config arrives as query parameters, parsed by the same schema the
 * jsonb column is read through (`src/widgets/config.ts`). That is what makes
 * this a preview rather than an approximation: the renderer, the scope clauses
 * and the config validation are all the ones the live widget uses, and the only
 * difference is where the values came from.
 */

const log = childLogger({ module: "widgets/preview" });

type RouteContext = { params: Promise<{ id: string }> };

const HTML = "text/html; charset=utf-8";

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;

  try {
    /**
     * Ownership first, through RLS: this read returns nothing unless the widget
     * belongs to the signed-in organization. Only then is the widget resolved
     * by its public key — reusing the one resolver rather than writing a second
     * join that would have to be kept in step with it.
     */
    const owned = await withAuthenticatedTenant((tx, actor) =>
      getWidget(tx, actor.organizationId, id),
    );
    if (!owned) return new Response("", { status: 404, headers: { "Content-Type": HTML } });

    const resolved = await resolveWidgetByKey(owned.publicKey);
    if (!resolved) return new Response("", { status: 404, headers: { "Content-Type": HTML } });

    // Unsaved edits win over the stored row; an empty query string previews the
    // widget exactly as it is saved.
    const override = new URL(request.url).searchParams;
    const config =
      override.size > 0
        ? widgetConfigFromParams(override)
        : { filters: resolved.filters, style: resolved.style };

    const widget: PublicWidget = {
      ...resolved,
      filters: config.filters,
      style: config.style,
      // The locale follows the previewed style, not the saved one, so switching
      // the language control shows the switch.
      locale: isLocale(config.style.locale ?? undefined)
        ? (config.style.locale as Locale)
        : resolved.locale,
    };

    const [content, labels] = await Promise.all([
      loadWidgetContent(widget),
      widgetLabels(widget.locale),
    ]);

    const document = renderWidgetDocument(content, labels);

    return new Response(document, {
      status: 200,
      headers: {
        "Content-Type": HTML,
        // Never cached: it is per-session, per-keystroke, and behind auth.
        "Cache-Control": "no-store, private",
        "Content-Security-Policy": widgetContentSecurityPolicy(document, {
          // Framed by our own builder and nothing else.
          frameAncestors: "'self'",
        }),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    log.warn({ err: error }, "Widget preview failed");
    return new Response("", { status: 500, headers: { "Content-Type": HTML } });
  }
}
