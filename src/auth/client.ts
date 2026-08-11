"use client";

import { inferAdditionalFields, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import type { Auth } from "./config";
import { ac, roles } from "./permissions";

/**
 * Browser-side auth client.
 *
 * Anything this exposes is a convenience for rendering, never an authorization
 * decision. `ac`/`roles` are passed so the UI can grey out actions the user
 * cannot perform — the server checks the same permissions again regardless.
 */
export const authClient = createAuthClient({
  plugins: [
    /**
     * Teaches the client about `user.additionalFields` (P5-T2).
     *
     * Without it `signUp.email` rejects `marketingEmailConsent` at the type
     * level and drops it at runtime, so the checkbox would render, tick, submit
     * — and record nothing. A consent that silently fails to save is worse than
     * no checkbox at all, because the screen tells the person it was recorded.
     *
     * **`import type { Auth }` and nothing else.** A type is erased at build
     * time; a runtime import of `./config` from a `"use client"` module would
     * pull `pg` into the browser bundle and fail the build on Node's `dns`.
     * That is the rule in CLAUDE.md, and this is the exact shape it permits.
     */
    inferAdditionalFields<Auth>(),
    organizationClient({ ac, roles }),
  ],
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  organization,
  useActiveOrganization,
  // Password recovery (W1.9b). Both are BetterAuth's own endpoints: the first
  // answers identically whether or not the address has an account, and the
  // second is the only thing that can judge a token.
  requestPasswordReset,
  resetPassword,
} = authClient;
