import { ne, type SQL } from "drizzle-orm";
import { schema } from "../db/client.ts";

/**
 * What counts as feedback about the business, and what is private post (A22-C1).
 *
 * `reviews` holds four kinds of thing, and they are not four kinds of review. A
 * Google review, an Instagram comment and an Instagram mention are all somebody
 * saying something in public about a café; a **direct message is a letter**. It
 * is addressed to the business, nobody else can read it, and it is as often
 * "did I leave my umbrella" as it is an opinion.
 *
 * **The bug this closes.** Nothing filtered on it. Three WhatsApp messages sat
 * inside "79 yorum", inside the count of reviews waiting for a reply, inside
 * the response-rate denominator — and a private note about a lost black
 * umbrella was clustered into a theme and printed in the weekly plan as
 * something to act on. `src/analytics/facts.ts` had excluded DMs since P3-T4
 * and every other reader had not, which is the shape of a rule that lives in
 * one query instead of in one module.
 *
 * **Comments and mentions stay.** They carry no star rating, and every rating
 * figure already filters on `rating is not null`, so they cannot move an
 * average. What they can move is volume and sentiment, and they should: an
 * Instagram comment saying the coffee was cold is the same news as a two-star
 * review saying it. Excluding them would throw away the fastest-moving source a
 * café has.
 *
 * The DMs themselves are not hidden — see `/conversations`, which is where a
 * letter belongs and where the product already says that answering one is not
 * built.
 */

/** Requires the `reviews` table in the query. */
export const PUBLIC_FEEDBACK: SQL = ne(schema.reviews.itemType, "dm");

/** The same rule over a projected fact, for the pure metric functions. */
export function isPublicFeedback(fact: { itemType: string }): boolean {
  return fact.itemType !== "dm";
}
