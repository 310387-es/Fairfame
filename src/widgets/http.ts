import { createHash } from "node:crypto";
import { consumeRateLimit } from "../lib/rate-limit.ts";

/**
 * The HTTP manners of a public, cacheable, cross-origin endpoint.
 *
 * Shared by the JSON API, the iframe document and the loader script so the
 * three cannot disagree about caching or CORS — the class of bug where one of
 * them quietly serves `no-store` and every page view becomes a database query.
 */

/**
 * CORS is wide open, and that is the correct answer rather than a shortcut.
 *
 * The data behind these endpoints is, by construction, what a business chose to
 * publish on the internet. There is nothing to protect with an origin check, and
 * an allow-list would be security theatre twice over: `Origin` is set by the
 * browser for honest callers and forged freely by anyone who is not one, and a
 * customer who moves their site to a staging domain would find their widget
 * silently blank. Tenancy is enforced by the key, not by the caller's hostname.
 *
 * `Vary: Origin` is deliberately absent: the response does not depend on the
 * origin, and adding it would fragment every CDN cache entry by referrer.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

/**
 * Cache windows.
 *
 * Content is browser-cached for a minute and CDN-cached for five, because a
 * newly approved review appearing within five minutes is fine and a widget that
 * hits the origin on every page view is not. `stale-while-revalidate` for a day
 * is what keeps a customer's homepage rendering through an outage of ours — the
 * failure mode to design for is not a stale quote, it is a blank space where the
 * testimonials were.
 *
 * The loader script is cached far harder: it is tiny, it changes rarely, and it
 * is on the critical path of somebody else's page load.
 */
export const CONTENT_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";
export const SCRIPT_CACHE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";

/**
 * Responses that must not be cached at all: a miss now may be a hit in a
 * minute, once the business publishes the widget.
 */
export const NO_CACHE = "no-store";

export function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...CORS_HEADERS, ...extra };
}

/** Preflight. Simple GETs never trigger one; a caller sending headers will. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/** Weak ETag over the body — enough for a 304, and cheap. */
export function etagFor(body: string): string {
  return `W/"${createHash("sha1").update(body).digest("base64url")}"`;
}

/**
 * A cacheable public response, with conditional-request handling.
 *
 * The 304 path matters more here than it looks: a widget is on a page people
 * revisit, and a repeat view that costs 200 bytes instead of 20KB is the
 * difference between a widget a customer keeps and one they blame for their
 * page speed score.
 */
export function cacheableResponse(
  request: Request,
  body: string,
  contentType: string,
  cacheControl = CONTENT_CACHE,
): Response {
  const etag = etagFor(body);
  const headers = corsHeaders({
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    ETag: etag,
  });

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(body, { status: 200, headers });
}

/**
 * "No such widget" — the single answer for every reason there might not be one.
 *
 * A missing key, a malformed key and an unpublished widget are deliberately
 * indistinguishable. Distinguishing them would turn the endpoint into an oracle
 * for which keys exist, which is the one thing an unguessable key is meant to
 * prevent.
 */
export function notFoundResponse(contentType = "application/json; charset=utf-8"): Response {
  const body = contentType.startsWith("application/json")
    ? JSON.stringify({ error: "not_found" })
    : "";
  return new Response(body, {
    status: 404,
    headers: corsHeaders({ "Content-Type": contentType, "Cache-Control": NO_CACHE }),
  });
}

/**
 * Best guess at the caller's address. Forgeable, so it is an abuse cost and not
 * an identity — the same reasoning as the submission endpoint.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || "unknown";
}

/**
 * Per-IP ceiling on uncached public reads.
 *
 * Generous on purpose. A widget sits on a busy site behind a CDN, so what
 * reaches the origin from any one address is small — this is sized to stop a
 * scraper walking the key space, not to police a real visitor. The limiter
 * fails open (see `src/lib/rate-limit.ts`), which is the right trade here too:
 * a Redis outage must not blank every customer's testimonials.
 */
const PUBLIC_READS_PER_MINUTE = 240;

export async function allowPublicRead(request: Request): Promise<boolean> {
  const { allowed } = await consumeRateLimit(
    `widget:${clientIp(request)}`,
    PUBLIC_READS_PER_MINUTE,
    60,
  );
  return allowed;
}

export function rateLimitedResponse(): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: corsHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": NO_CACHE,
      "Retry-After": "60",
    }),
  });
}
