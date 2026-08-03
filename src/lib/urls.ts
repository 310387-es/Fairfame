import { getEnv } from "./env.ts";

/**
 * Public links we hand to customers.
 *
 * These end up printed on a QR code taped to a counter, so they must be short,
 * stable and unambiguous. The builders are pure functions of an explicit base
 * URL; the `*Url()` wrappers read the configured origin. Tests use the pure
 * forms and never need environment configuration.
 */

/** Trailing slashes make `${base}/c/${slug}` produce a double slash. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Where public collection pages live. `APP_URL` when set, otherwise the auth
 * origin — in local dev they are the same host, and in production the
 * collection pages may move to their own domain without touching auth.
 */
export function publicBaseUrl(): string {
  const env = getEnv();
  return trimTrailingSlash(env.APP_URL ?? env.BETTER_AUTH_URL);
}

/**
 * Where the dashboard lives — the origin a signed-in user browses.
 *
 * Deliberately `BETTER_AUTH_URL` rather than `publicBaseUrl()`. The two are the
 * same host in dev, but `APP_URL` exists so public collection pages can move to
 * their own domain, and a notification deep-link that followed it would send a
 * team member to a customer-facing origin where they are not signed in.
 */
export function dashboardBaseUrl(): string {
  return trimTrailingSlash(getEnv().BETTER_AUTH_URL);
}

/** An absolute link into the dashboard, for email. */
export function dashboardUrl(path: string): string {
  return `${dashboardBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The campaign's own page: what a QR code or a printed short link points at. */
export function buildCampaignUrl(base: string, slug: string): string {
  return `${trimTrailingSlash(base)}/c/${slug}`;
}

/** A single ask, addressed to one person. Carries the tracking token. */
export function buildRequestUrl(base: string, token: string): string {
  return `${trimTrailingSlash(base)}/r/${token}`;
}

/** One-click opt-out. Present in every outbound message, without exception. */
export function buildUnsubscribeUrl(base: string, token: string): string {
  return `${trimTrailingSlash(base)}/u/${token}`;
}

export function campaignUrl(slug: string): string {
  return buildCampaignUrl(publicBaseUrl(), slug);
}

export function requestUrl(token: string): string {
  return buildRequestUrl(publicBaseUrl(), token);
}

export function unsubscribeUrl(token: string): string {
  return buildUnsubscribeUrl(publicBaseUrl(), token);
}
