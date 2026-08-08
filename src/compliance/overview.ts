import { and, eq, isNotNull, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { getEnv } from "../lib/env.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { getIysGateway } from "./gate.ts";
import { isRegisteredVia } from "./iys-gateway.ts";
import { overdueUploadCount } from "./consent.ts";

/**
 * What the compliance page says about an organization (positioning win 3).
 *
 * > **Compliance page** (İYS status + KVKK tooling + the no-rating-gating
 * > statement) — then put it on the pricing page. It's the one claim a
 * > competitor can't copy in a quarter.
 *
 * The claim is only worth making if the screen behind it is honest, so this
 * module's job is to produce numbers that can embarrass us. Three rules:
 *
 *   - **A `local` upload is not a registration.** Every accepted consent row
 *     records `iys_uploaded_via` precisely so the two stay distinguishable
 *     forever (P1b-T5), and `isRegisteredVia`'s allowlist is empty until a real
 *     BSP adapter exists. So the counts are split, and the screen says which is
 *     which rather than reporting one flattering total.
 *   - **Overdue is stated, never hidden.** Turkish law gives three business
 *     days from the moment somebody ticks the box. A queue that looked healthy
 *     because it dropped the rows it had missed would be the worst possible
 *     version of this page.
 *   - **Nothing here is a permission to send.** `checkSendAllowed` remains the
 *     only thing that decides that, because it re-reads the opt-out and asks
 *     the registry at the moment of sending. These are counts.
 */

export type ConsentTally = {
  /** Live İYS permissions on record, whatever accepted them. */
  recorded: number;
  /** Of those, the ones a *real* registry accepted. Zero until a BSP exists. */
  registered: number;
  /** Captured, accepted by nothing yet, still inside their three days. */
  pending: number;
  /** Past the deadline. The number that has to be visible. */
  overdue: number;
  /** People who have said no. Not a failure — a working opt-out. */
  optedOut: number;
};

export type ComplianceOverview = {
  /** The configured gateway's name, or null when nothing is wired. */
  gateway: string | null;
  /** True when the gateway is one that actually reaches İYS. */
  gatewayIsReal: boolean;
  /** Whether this deployment requires an İYS check before a commercial send. */
  required: boolean;
  consents: ConsentTally;
};

export async function complianceOverview(
  tx: TenantDatabase,
  organizationId: string,
  now = new Date(),
): Promise<ComplianceOverview> {
  const gateway = getIysGateway()?.name ?? null;

  const [tally] = await tx
    .select({
      recorded:
        sql<number>`count(*) filter (where ${schema.consentRecords.revokedAt} is null)::int`.mapWith(
          Number,
        ),
      // The `via` allowlist is the honest half. Counting "uploaded" would
      // include every `local` acceptance and report a compliance posture this
      // deployment does not have.
      registered:
        sql<number>`count(*) filter (where ${schema.consentRecords.revokedAt} is null and ${schema.consentRecords.iysUploadedVia} is not null and ${sql.raw(registeredViaPredicate())})::int`.mapWith(
          Number,
        ),
      pending:
        sql<number>`count(*) filter (where ${schema.consentRecords.revokedAt} is null and ${schema.consentRecords.iysUploadedAt} is null)::int`.mapWith(
          Number,
        ),
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.organizationId, organizationId),
        eq(schema.consentRecords.type, "iys"),
      ),
    );

  const [optedOut] = await tx
    .select({ total: sql<number>`count(*)::int`.mapWith(Number) })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.organizationId, organizationId),
        isNotNull(schema.contacts.unsubscribedAt),
      ),
    );

  const overdue = await overdueUploadCount(tx, organizationId, now);

  return {
    gateway,
    gatewayIsReal: isRegisteredVia(gateway),
    required: getEnv().IYS_REQUIRED,
    consents: {
      recorded: tally?.recorded ?? 0,
      registered: tally?.registered ?? 0,
      // Pending includes the overdue — they are still not uploaded — so the
      // "still in time" figure the screen shows is the difference.
      pending: Math.max(0, (tally?.pending ?? 0) - overdue),
      overdue,
      optedOut: optedOut?.total ?? 0,
    },
  };
}

/**
 * The SQL half of `isRegisteredVia`.
 *
 * Its allowlist is **empty today**, which is the true answer until a real BSP
 * adapter lands — and an empty `IN ()` is a syntax error, so this renders
 * `false` rather than an empty list. When the allowlist gains an entry this
 * predicate gains it too; keeping them in one file is what stops the screen and
 * the gateway disagreeing about what counts as registered.
 */
function registeredViaPredicate(): string {
  const allowed = REGISTERED_GATEWAYS.filter((name) => isRegisteredVia(name));
  if (allowed.length === 0) return "false";
  return `${'"consent_records"."iys_uploaded_via"'} in (${allowed.map((name) => `'${name}'`).join(", ")})`;
}

/**
 * Every gateway name this product has ever written into `iys_uploaded_via`.
 *
 * Filtered through `isRegisteredVia` above rather than trusted, so adding a
 * name here cannot accidentally promote a development adapter to a registration.
 */
const REGISTERED_GATEWAYS = ["local", "none"] as const;

/**
 * Finds the contact behind an email address or a phone number.
 *
 * The KVKK panel takes what a person writes in a letter — "please delete my
 * data, my number is 0532…" — rather than a contact id nobody outside this
 * database has. `contacts` has been "the one place a customer's email or phone
 * is stored" since P1b-T1, which is exactly what makes this one query.
 *
 * Returns null rather than throwing on no match: "we hold nothing about this
 * person" is a legitimate and common answer to a subject request, and it is the
 * one the operator has to be able to give.
 */
export async function findContactByIdentifier(
  tx: TenantDatabase,
  organizationId: string,
  identifier: string,
): Promise<{ id: string; name: string | null; email: string | null; phone: string | null } | null> {
  const needle = identifier.trim().toLowerCase();
  if (needle.length === 0) return null;

  const [row] = await tx
    .select({
      id: schema.contacts.id,
      name: schema.contacts.name,
      email: schema.contacts.email,
      phone: schema.contacts.phone,
    })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.organizationId, organizationId),
        sql`(lower(${schema.contacts.email}) = ${needle} or ${schema.contacts.phone} = ${identifier.trim()})`,
      ),
    )
    .limit(1);

  return row ?? null;
}
