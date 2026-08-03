import { ConnectorError } from "@/connectors/types";
import { EntitlementError } from "@/lib/entitlements";
import { ForbiddenError, NoActiveOrganizationError, UnauthenticatedError } from "@/auth/session";

/**
 * What a server action hands back to the form that called it.
 *
 * Kept out of the "use server" modules deliberately: those may only export
 * async functions, so a shared helper cannot live there — and a helper that is
 * copied into every action file eventually stops agreeing with itself about
 * what an error looks like.
 *
 * `code` is a machine-readable hint (`entitlement:max_locations`) the UI can
 * key an upgrade prompt off, while `error` stays human-readable.
 */

export type ActionResult<T = unknown> =
  ({ ok: true } & T) | { ok: false; error: string; code?: string };

export function toActionResult(error: unknown): { ok: false; error: string; code?: string } {
  if (error instanceof EntitlementError) {
    return { ok: false, error: error.message, code: `entitlement:${error.key}` };
  }
  if (error instanceof ConnectorError) {
    return { ok: false, error: error.message, code: `connector:${error.provider}` };
  }
  if (error instanceof ForbiddenError) {
    return { ok: false, error: error.message, code: "forbidden" };
  }
  if (error instanceof UnauthenticatedError || error instanceof NoActiveOrganizationError) {
    return { ok: false, error: error.message, code: "unauthenticated" };
  }
  if (error instanceof Error) {
    return { ok: false, error: error.message };
  }
  return { ok: false, error: "Something went wrong." };
}
