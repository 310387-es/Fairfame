/**
 * Billing credential access.
 *
 * Read straight from process.env rather than through the Zod config, on
 * purpose. `isConfigured()` is a capability probe — callers use it to decide
 * whether to offer a payment path at all — so it has to be total. Routing it
 * through the full validated env made a question about one optional secret
 * throw whenever any unrelated variable was missing, which is precisely
 * backwards.
 *
 * The variables are still declared in src/lib/env.ts so they stay documented,
 * typed, and mirrored in .env.example; they are optional there, so nothing is
 * lost by reading them directly here.
 */

/** Empty means absent: an unset credential must never read as configured. */
export function billingSecret(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}
