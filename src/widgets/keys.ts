import { looksLikeCode, randomCode } from "../lib/codes.ts";

/**
 * The public key in a widget's embed snippet.
 *
 * Not a secret — it is pasted into a customer's page source, and anyone reading
 * that page can read it. What it must resist is *enumeration*: the key is the
 * only thing the public endpoint is given, so guessing keys is the one way an
 * outsider could go looking for other businesses' widgets. 24 characters over a
 * 31-symbol alphabet is ~119 bits, which makes that hopeless.
 *
 * `looksLikeWidgetKey` is the cheap shape check that keeps a junk path segment
 * from reaching the database at all — a public endpoint should not spend a
 * connection on `/api/public/widgets/<script>alert(1)</script>`.
 */

export const WIDGET_KEY_LENGTH = 24;

export function generateWidgetKey(): string {
  return randomCode(WIDGET_KEY_LENGTH);
}

export function looksLikeWidgetKey(value: string): boolean {
  return looksLikeCode(value, WIDGET_KEY_LENGTH);
}
