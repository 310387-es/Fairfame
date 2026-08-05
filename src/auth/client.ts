"use client";

import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { ac, roles } from "./permissions";

/**
 * Browser-side auth client.
 *
 * Anything this exposes is a convenience for rendering, never an authorization
 * decision. `ac`/`roles` are passed so the UI can grey out actions the user
 * cannot perform — the server checks the same permissions again regardless.
 */
export const authClient = createAuthClient({
  plugins: [organizationClient({ ac, roles })],
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
