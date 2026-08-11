/**
 * Removes the accounts the browser suite creates.
 *
 *   pnpm test:e2e:clean
 *
 * Every run signs up a fresh account so the tests never depend on each other's
 * leftovers, which means a developer's database slowly fills with them. They are
 * all identifiable by their email domain, so this is a narrow delete rather than
 * a truncate — it cannot touch a real account, and it cannot touch the seed.
 */
import { like } from "drizzle-orm";
import { closeDatabasePools, getAdminDb, schema } from "../src/db/client.ts";

/** Kept in step with `E2E_EMAIL_DOMAIN` in e2e/auth.setup.ts. */
const DOMAIN = "e2e.fairfame.test";

const removed = await getAdminDb()
  .delete(schema.users)
  .where(like(schema.users.email, `%@${DOMAIN}`))
  .returning({ email: schema.users.email });

// Organizations cascade from their creator's membership only if nothing else
// holds them, so they are cleared by name too.
const orgs = await getAdminDb()
  .delete(schema.organizations)
  .where(like(schema.organizations.slug, "e2e-%"))
  .returning({ slug: schema.organizations.slug });

console.log(`Removed ${removed.length} e2e user(s) and ${orgs.length} e2e organization(s).`);

await closeDatabasePools();
