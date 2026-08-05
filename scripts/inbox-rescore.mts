/**
 * Recomputes every review's triage priority from what the database now holds.
 *
 *   pnpm inbox:rescore                 # every organization
 *   pnpm inbox:rescore -- --org acme   # one, by slug
 *
 * **Why this exists.** `priority` is a derived column, and the formula lives in
 * TypeScript (`src/inbox/workflow.ts`) precisely so there is only one of it —
 * which means a SQL migration cannot apply a change to it. `refreshPriority`
 * runs at ingest, after analysis and after a reply, so *new* activity re-scores
 * itself; rows nothing has touched since keep whatever they were given.
 *
 * It was written for migration 0042 (W1.2): once a reply the owner left on the
 * platform counts as an answer, every review carrying one was scored 55 points
 * too high and sat at the top of a queue it did not belong in. Run it after any
 * migration or formula change that alters an input to `computePriority`.
 *
 * Idempotent and cheap to repeat: `refreshPriority` writes only the rows whose
 * score actually changed, and reports how many that was.
 */
import { eq } from "drizzle-orm";
import { closeDatabasePools, getAdminDb, schema } from "../src/db/client.ts";
import { refreshPriority } from "../src/inbox/workflow.ts";
import { withTenant } from "../src/lib/tenancy.ts";

const args = process.argv.slice(2);
const index = args.indexOf("--org");
const slug = index === -1 ? undefined : args[index + 1];

/** Enough to keep one UPDATE's VALUES list sane on a large corpus. */
const BATCH = 500;

const organizations = await getAdminDb()
  .select({ id: schema.organizations.id, slug: schema.organizations.slug })
  .from(schema.organizations)
  .where(slug ? eq(schema.organizations.slug, slug) : undefined);

if (organizations.length === 0) {
  console.error(slug ? `No organization with slug "${slug}".` : "No organizations.");
  await closeDatabasePools();
  process.exit(1);
}

let total = 0;

for (const organization of organizations) {
  // Inside the tenant context like every other read of tenant data — an
  // operator script is not an exemption from RLS, it is the place a missing
  // one would go unnoticed longest.
  const changed = await withTenant({ organizationId: organization.id }, async (tx) => {
    const ids = await tx
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(eq(schema.reviews.organizationId, organization.id));

    let count = 0;
    for (let start = 0; start < ids.length; start += BATCH) {
      count += await refreshPriority(
        tx,
        organization.id,
        ids.slice(start, start + BATCH).map((row) => row.id),
      );
    }
    return count;
  });

  total += changed;
  console.log(`${organization.slug}: rescored ${changed}`);
}

console.log(`Done — ${total} review${total === 1 ? "" : "s"} rescored.`);

await closeDatabasePools();
