import { withSentryConfig } from "@sentry/nextjs";
import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // pino resolves its transport target (pino-pretty) at runtime in a worker
  // thread. Bundling breaks that resolution, so keep both external on the server.
  //
  // `@react-pdf/renderer` is external for a related reason: it loads fontkit and
  // resolves font files at runtime, and it is only ever used from a route
  // handler and the background worker — bundling it buys nothing and breaks the
  // resolution it does for itself.
  serverExternalPackages: ["pino", "pino-pretty", "@react-pdf/renderer"],

  /**
   * The old route names, kept alive (W3.1).
   *
   * Every screen was named for the thing we built rather than the job somebody
   * came to do, and the rail was fifteen items of that. The renames fix the
   * words; these keep the *addresses* working, because they are in bookmarks,
   * in sent emails, in a browser's autocomplete and in whatever somebody pasted
   * into a group chat six months ago.
   *
   * **Permanent, not temporary.** A 308 tells a crawler and a browser the move
   * is settled; a 307 asks them both to keep checking forever. The one thing
   * that must not happen is an owner clicking a link from an alert we sent and
   * landing on a 404.
   *
   * `:path*` carries the rest of the URL through, so
   * `/inbox?review=abc&overdue=1` arrives at `/reviews` with its query intact —
   * a redirect that dropped the query would take somebody to the right screen
   * showing the wrong thing, which is worse than not moving them at all.
   */
  async redirects() {
    return [
      ["/home", "/dashboard"],
      ["/inbox", "/reviews"],
      ["/digest", "/weekly-plan"],
      ["/messages", "/conversations"],
      ["/requests", "/get-reviews"],
      /*
        Reversed, 8 Aug 2026 — and it must *replace* the old pair rather than
        join it, or `/broadcasts` and `/campaigns` redirect to each other
        forever.

        W3.1 renamed `/broadcasts` to `/campaigns` for a good reason: campaign
        is the word a marketer scans for. What it did not weigh is that
        **`campaigns` was already taken**. The table is `campaigns`, the API
        route is `/api/campaigns/{id}/qr`, `src/collect/campaigns.ts` owns them,
        and `/get-reviews` calls its own objects campaigns on screen — so the
        product had two different things one rail-click apart under one word.
        `CLAUDE.md` recorded the collision as open and unresolved.

        The broadcast screen is the side that moves, because it is the only one
        where the word was borrowed: the code, the table, the job (`broadcast_
        sweep`) and the folder all say broadcast already, and the Turkish copy
        never used "kampanya" for it at all — it has said "Gönderimler" since
        P4-T4. Renaming this screen makes route, folder, table and label agree,
        which is the rule the rest of the codebase keeps.

        A bookmark from before W3.1 now resolves to a real route rather than a
        redirect, and one made since lands here.
      */
      ["/campaigns", "/broadcasts"],
      ["/insights", "/analytics"],
      ["/clients", "/agency"],
    ].flatMap(([from, to]) => [
      { source: from!, destination: to!, permanent: true },
      { source: `${from}/:path*`, destination: `${to}/:path*`, permanent: true },
    ]);
  },
};

/**
 * Sentry's build-time half: source-map upload and bundle instrumentation.
 *
 * The runtime half — what is captured and what is scrubbed — lives in
 * `src/lib/sentry-options.ts` and the three init files. Nothing about the DSN
 * belongs here.
 */
export default withSentryConfig(withNextIntl(nextConfig), {
  org: "fairfame",
  project: "fairfame-web",

  // Upload logs only where a human is not watching a progress bar.
  silent: !process.env.CI,

  // Wider upload: prettier stack traces, slower build. Worth it — a minified
  // frame in a report about a screen nobody can reproduce is not worth having.
  widenClientFileUpload: true,

  sourcemaps: {
    /**
     * Delete the maps once Sentry has them.
     *
     * Without this the build emits `.map` files into `.next/static` and the
     * server hands them to anyone who asks, which publishes readable source —
     * including the shape of every server action and entitlement check — to the
     * open internet. Sentry keeps its own copy, so nothing is lost by the
     * deletion; only the public copy goes away.
     */
    deleteSourcemapsAfterUpload: true,
  },

  /**
   * A public, unauthenticated POST endpoint. Kept deliberately, and worth
   * knowing about.
   *
   * Ad blockers block requests to `*.sentry.io` aggressively, so without a
   * tunnel a meaningful share of browser errors never arrive — and they are
   * disproportionately the errors of the more technical customers. The rewrite
   * makes them same-origin.
   *
   * The cost is a route a stranger can post to, which is the category
   * CLAUDE.md calls the hardest boundary in the product. It is not enumerated
   * by `tests/db/public-leakage.test.ts`, because that test walks route files
   * on disk and this route is generated by the plugin — so it is written down
   * here instead. It forwards to Sentry and reads nothing from our database,
   * which is why it does not need the tenant reasoning the others do.
   */
  tunnelRoute: "/monitoring",

  webpack: {
    // Off: this instruments Vercel Cron Monitors, and the scheduled work here
    // is BullMQ in `pnpm worker`, which Vercel never sees. Leaving it on
    // advertises a monitor for jobs that will never report to it.
    automaticVercelMonitors: false,

    treeshake: {
      removeDebugLogging: true,
    },
  },
});
