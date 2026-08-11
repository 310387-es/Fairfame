import { like } from "drizzle-orm";
import { getAdminDb, schema } from "@/db/client";

/**
 * Removes the user rows a suite created, which deleting its organizations does
 * not.
 *
 * **Why this is needed at all.** Every DB suite tidies up by deleting its
 * organizations, and that looked complete because it *is* complete for
 * everything an organization owns — `memberships`, `reviews`, `contacts` and
 * the rest cascade away with it. `users` does not, and cannot: a person belongs
 * to many organizations, so the table has no `organization_id` and no foreign
 * key pointing back at one. Deleting the organization removes the membership
 * and leaves the user, now referenced by nothing.
 *
 * The leak is invisible per run and unbounded across them. A local database
 * reached **3,264 orphaned users** — zero memberships, zero sessions, zero
 * accounts between them — from a single afternoon of running `pnpm test:db`,
 * and nothing failed, which is exactly why nobody noticed. What it costs is not
 * disk: it is that `SELECT count(*) FROM users` stops being a number anyone can
 * reason about, so the one question you would ask a dev database — *is this
 * shape right?* — stops having an answer.
 *
 * **Matched on the suite's own run suffix rather than on a tracked array.**
 * Every suite already stamps a `crypto.randomUUID().slice(0, 8)` into the
 * addresses it creates, and matching on that catches every user the run made
 * however it made them — including the ones minted inside a helper that returns
 * an id without pushing it anywhere, which is how most of these leaked. A
 * tracking array only catches the rows somebody remembered to track, and the
 * bug is precisely that they did not.
 *
 * Call it in `afterAll`, before `closeDatabasePools()`.
 */
export async function dropFixtureUsers(suffix: string): Promise<void> {
  // A guard, not politeness: an empty suffix would match every address in the
  // database, and this runs against a developer's local one.
  if (suffix.length < 6) {
    throw new Error(`Refusing to delete users on a suffix this short: "${suffix}"`);
  }

  await getAdminDb()
    .delete(schema.users)
    .where(like(schema.users.email, `%${suffix}%`));
}
