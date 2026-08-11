/**
 * Sentry for the worker process.
 *
 * A module rather than a few lines inside `worker.mts`, and imported by that
 * file **first**, because ES modules evaluate in import order: initialising
 * here means the SDK is installed before `pg`, `ioredis` and `bullmq` are
 * loaded, which is what lets it instrument them. Initialising further down —
 * after those imports have already been evaluated — still captures errors, but
 * silently loses the database and queue spans.
 *
 * `@sentry/node`, not `@sentry/nextjs`: the worker is a plain Node process with
 * no bundler. Node resolves `@sentry/nextjs` to its CJS server build, whose
 * ESM named exports come out incomplete — `flush` and `captureException` are
 * both missing, so the shutdown path below could not work. The two packages are
 * pinned to the same version and `@sentry/nextjs` depends on this one, so there
 * is no second copy and no version to drift.
 *
 * Nothing here reaches a request API — the CLAUDE.md rule that took `pnpm
 * worker` down once already, at startup, in the process nobody is watching.
 */
import * as Sentry from "@sentry/node";

import { scrubEvent, sharedSentryOptions } from "../src/lib/sentry-options.ts";

Sentry.init({
  ...sharedSentryOptions,

  /**
   * The worker's own name in Sentry.
   *
   * Without it, a failed digest sweep and a failed page render are the same
   * "production" to anyone reading the dashboard. The whole argument for
   * instrumenting this process is that nobody is watching it, so the reports
   * have to say where they came from.
   */
  serverName: "worker",

  beforeSend: scrubEvent,
});

export { Sentry };
