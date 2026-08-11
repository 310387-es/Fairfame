/**
 * Sentry, in the Node server runtime.
 *
 * Loaded by `register()` in src/instrumentation.ts — nothing imports this file
 * implicitly, which is the whole reason the wizard's version never ran.
 */
import * as Sentry from "@sentry/nextjs";

import { scrubEvent, sharedSentryOptions } from "./src/lib/sentry-options.ts";

Sentry.init({
  ...sharedSentryOptions,

  /**
   * Off, both of them, against the wizard's commented-out defaults.
   *
   * `userInfo` sends the signed-in user's email and IP; `httpBodies` sends
   * request payloads. On this app a payload is routinely a review's text, a
   * customer's name or a phone number — personal data under KVKK/GDPR, and
   * this is the option that decides whether it reaches a third party.
   *
   * The empty array is not "default": it is an explicit refusal of every body.
   */
  dataCollection: {
    userInfo: false,
    httpBodies: [],
  },

  beforeSend: scrubEvent,
});
