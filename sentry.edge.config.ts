/**
 * Sentry, in the edge runtime (middleware and edge routes).
 *
 * Loaded by `register()` in src/instrumentation.ts, and it must be loaded
 * *before* that function's `NEXT_RUNTIME !== "nodejs"` guard returns — see the
 * comment there. Keep this file free of node-only imports for the same reason
 * the guard exists.
 */
import * as Sentry from "@sentry/nextjs";

import { scrubEvent, sharedSentryOptions } from "./src/lib/sentry-options.ts";

Sentry.init({
  ...sharedSentryOptions,

  // Same refusal as the server config, for the same reason. See the comment
  // there before changing either.
  dataCollection: {
    userInfo: false,
    httpBodies: [],
  },

  beforeSend: scrubEvent,
});
