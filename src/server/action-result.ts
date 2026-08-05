import type { ZodError } from "zod";
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

export type FieldErrors = Record<string, string>;

export type ActionResult<T = unknown> =
  ({ ok: true } & T) | { ok: false; error: string; code?: string; fieldErrors?: FieldErrors };

/**
 * A Zod failure, in the shape a form can render against its own fields (W1.5).
 *
 * **What this replaces.** Every action validated its input and then threw the
 * detail away — `if (!parsed.success) return { ok: false, error: "Invalid
 * location." }`. Zod knew exactly which field was wrong and why; the reader was
 * told that something, somewhere, was invalid. On a form with eleven controls
 * that is not a message, it is a puzzle.
 *
 * Keyed by the **top-level** field name, because that is what a form control is
 * called: `destinationUrl`, not `destinationUrl.0.href`. A nested issue reports
 * against the field it belongs to, which is the control the reader can actually
 * go and fix. The first issue per field wins — a control shows one message, and
 * listing three ways a value is wrong helps nobody.
 *
 * Issues with an empty path (a `superRefine` about the object as a whole) have
 * no field to attach to and are deliberately dropped here; they surface as the
 * action's `error`, which is the toast.
 */
export function toFieldErrors(error: ZodError): FieldErrors {
  const fields: FieldErrors = {};

  for (const issue of error.issues) {
    const [field] = issue.path;
    if (typeof field !== "string") continue;
    if (fields[field] !== undefined) continue;
    fields[field] = issue.message;
  }

  return fields;
}

/**
 * The standard refusal for input that failed its schema.
 *
 * One helper rather than the sentence written out in twenty action files, so
 * "invalid" reads the same everywhere and no action can accidentally return
 * field errors without a summary or a summary without the fields.
 */
export function invalidInput(
  error: ZodError,
  message = "Check the highlighted fields.",
): {
  ok: false;
  error: string;
  fieldErrors: FieldErrors;
} {
  return { ok: false, error: message, fieldErrors: toFieldErrors(error) };
}

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
