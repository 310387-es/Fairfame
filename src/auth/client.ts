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

export const { signIn, signUp, signOut, useSession, organization, useActiveOrganization } =
  authClient;
