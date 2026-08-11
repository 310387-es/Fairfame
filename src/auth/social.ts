import { getEnv } from "../lib/env.ts";

/**
 * Whether "Continue with Google" exists in this deployment.
 *
 * **One reader of the two variables, because the button and the provider have
 * to agree.** If the config registered Google and the screen did not offer it,
 * the feature would be invisible; if the screen offered it and the config had
 * not registered it, the button would send somebody to a BetterAuth endpoint
 * that answers `CLIENT_ID_AND_SECRET_REQUIRED` — a runtime error on the front
 * door, in the one place the product cannot afford one. Both ask here.
 *
 * A missing credential is the ordinary state, not a misconfiguration: this repo
 * has never held a Google OAuth client, and `emailAndPassword` is a complete
 * way in without one.
 *
 * Server-only, because `getEnv` is. The auth screens are server components and
 * pass the answer down as a prop — the alternative, a `NEXT_PUBLIC_` mirror of
 * a secret's *presence*, is two sources of truth for one fact.
 */
export function isGoogleAuthConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.GOOGLE_AUTH_CLIENT_ID && env.GOOGLE_AUTH_CLIENT_SECRET);
}
