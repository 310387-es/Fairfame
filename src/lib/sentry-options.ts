/**
 * What we send to Sentry, and what we refuse to send.
 *
 * **No imports at all**, deliberately — the same rule `src/replies/style.ts`
 * keeps. This module is read by four runtimes with four different sets of
 * available globals: the browser bundle (`instrumentation-client.ts`), the
 * Node server, the edge runtime, and the standalone worker process. Anything
 * imported here would have to be valid in all four, and the first import that
 * reached `pg` would take `pnpm worker` down at startup — the failure mode
 * CLAUDE.md's worker rule exists for.
 *
 * It is one module rather than four copies because the scrubber below is a
 * compliance control, not a preference. Four copies drift, and the copy that
 * drifts is the one nobody reads again.
 */

/**
 * The DSN, from the environment rather than baked into the source.
 *
 * The wizard hardcodes it into all three config files. That works, and it is
 * what Sentry's docs show, but it means **every environment reports into the
 * same project**: a developer's typo, a CI build and a customer's real crash
 * all land in one issue stream, and the alert that matters is buried under the
 * ones that do not. Absent is therefore the correct default for dev and CI —
 * an empty DSN makes `Sentry.init` a no-op, which is exactly what we want
 * there.
 *
 * `NEXT_PUBLIC_` because the browser needs it and Next inlines that prefix at
 * build time. It is not a secret: it ships inside the client bundle by design,
 * and can only be used to *write* events into the project.
 */
export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";

/** Absent DSN means Sentry is off, everywhere, with no further ceremony. */
export const SENTRY_ENABLED = SENTRY_DSN.length > 0;

/**
 * Which deployment an event came from — the tag that separates a developer's
 * noise from a customer's crash inside one project.
 *
 * `NODE_ENV` is the default and is right for local work (`development`) and for
 * CI (`test`). It is *not* enough on its own once anything else exists: a
 * staging deployment builds with `NODE_ENV=production` too, so without an
 * override staging's errors are indistinguishable from real customers'
 * — and an alert that pages someone at 3am cannot tell them apart either.
 *
 * `NEXT_PUBLIC_` because the browser has to send the same tag as the server;
 * an event reported as `production` from the client and `staging` from the
 * server is one incident split across two environments.
 */
export const SENTRY_ENVIRONMENT =
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development";

/**
 * Tracing costs quota per span, and the wizard's `1` means every request in
 * production. Ten percent is plenty to see a slow route; the server may raise
 * it with `SENTRY_TRACES_SAMPLE_RATE` while chasing something specific.
 */
export const SENTRY_TRACES_SAMPLE_RATE = sampleRate(
  process.env.SENTRY_TRACES_SAMPLE_RATE,
  SENTRY_ENVIRONMENT === "production" ? 0.1 : 1,
);

function sampleRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  // A malformed rate must not silently become 0 and turn tracing off — nor
  // silently become 1 and bill for everything. Fall back and keep going.
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

/**
 * URL path segments that are credentials.
 *
 * `/r/<token>`, `/u/<token>` and `/c/<slug>` are the unguessable-token routes
 * minted by `contactBehindToken` (`src/collect/public.ts`). Anyone holding one
 * can act as that contact — unsubscribe them, answer a survey as them. Sentry
 * captures the request URL on every event, and Sentry access is not the same
 * population as production database access, so an un-redacted token turns an
 * error report into a working credential sitting in a third-party UI.
 *
 * Widget and badge keys are deliberately *not* redacted: they are published on
 * customers' own websites, and knowing which tenant an error belongs to is the
 * first thing anyone debugging it needs.
 */
const TOKEN_ROUTES = /\/(r|u|c)\/[^/?#]+/g;

/** Headers that carry a session or a credential rather than a clue. */
const SENSITIVE_HEADERS = new Set(["cookie", "set-cookie", "authorization", "x-hub-signature-256"]);

export function redactTokens(url: string): string {
  return url.replace(TOKEN_ROUTES, (_match, route: string) => `/${route}/[redacted]`);
}

/**
 * The shape of a Sentry event, narrowed to the parts we touch.
 *
 * Declared locally rather than imported from `@sentry/types` because this
 * module takes no imports — see the header. The scrubber is defensive about
 * every field anyway, since an event from a runtime we did not anticipate is
 * exactly the one that would carry something unexpected.
 */
type ScrubbableEvent = {
  request?: {
    url?: string;
    cookies?: unknown;
    data?: unknown;
    headers?: Record<string, string>;
    query_string?: unknown;
  };
  user?: Record<string, unknown>;
  breadcrumbs?: { data?: { url?: string } }[];
};

/**
 * Strip personal data before an event leaves the process.
 *
 * Reviews are personal data under KVKK/GDPR (CLAUDE.md), and a review's text,
 * its author's name and a contact's phone number all routinely appear in
 * request bodies on this app's own routes. `dataCollection` below already
 * refuses bodies and user info; this is the second layer, because the option
 * governs what Sentry *collects automatically* and this governs what leaves
 * regardless of how it got onto the event.
 *
 * It keeps `user.id` — an opaque UUID is what makes an issue actionable, and
 * it identifies a row rather than a person.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.request) {
    if (event.request.url) event.request.url = redactTokens(event.request.url);

    // Bodies and query strings carry review text, names and phone numbers on
    // this app's public submit and survey routes.
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;

    if (event.request.headers) {
      for (const name of Object.keys(event.request.headers)) {
        if (SENSITIVE_HEADERS.has(name.toLowerCase())) delete event.request.headers[name];
      }
    }
  }

  if (event.user) {
    const id = event.user.id;
    // Rebuild rather than delete: a future Sentry version adding a PII field
    // would be carried through by a blocklist, and not by this.
    event.user = id === undefined ? {} : { id };
  }

  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.data?.url) crumb.data.url = redactTokens(crumb.data.url);
  }

  return event;
}

/**
 * Options every runtime shares.
 *
 * `enableLogs` is off against the wizard's default. pino is this app's logging
 * contract and it writes review text, contact details and İYS decisions at
 * debug level quite legitimately; shipping that stream to Sentry would route
 * personal data to a third party through a channel nobody audited for it.
 * Errors and traces are what we came for.
 */
export const sharedSentryOptions = {
  dsn: SENTRY_DSN,
  enabled: SENTRY_ENABLED,
  environment: SENTRY_ENVIRONMENT,
  tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
  enableLogs: false,
} as const;
