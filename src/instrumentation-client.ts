/**
 * Sentry, in the browser.
 *
 * Next loads this file automatically on the client — unlike the server and
 * edge configs, which `register()` has to import by hand.
 */
import * as Sentry from "@sentry/nextjs";

import { scrubEvent, sharedSentryOptions } from "./lib/sentry-options.ts";

Sentry.init({
  ...sharedSentryOptions,

  /**
   * Session Replay, narrowed on purpose.
   *
   * Replay records the DOM, and this product's screens are full of other
   * people's personal data: review text, customer names, phone numbers, survey
   * answers. The wizard's defaults record **10% of all sessions**, error or
   * not, which is a standing recording of customers' data made for no
   * particular reason.
   *
   * So: nothing is recorded routinely, and a replay is kept only when an error
   * actually occurred, where it earns its keep. `maskAllText` and
   * `blockAllMedia` are Replay's defaults and are restated here because a
   * default that matters should not be invisible — and because reading this
   * file is how somebody will decide whether to raise the session rate.
   */
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1,

  dataCollection: {
    userInfo: false,
    httpBodies: [],
  },

  beforeSend: scrubEvent,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
