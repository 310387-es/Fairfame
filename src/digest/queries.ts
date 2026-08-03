import { and, asc, desc, eq } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import type { DigestPayload } from "./pipeline.ts";

/**
 * Reading digests (P1a-T7).
 *
 * Separate from the pipeline for the same reason `insights.ts` is separate from
 * `analyze.ts`: generation and rendering change for different reasons, and the
 * Home screen (T8) must not import a module that can spend money.
 */

export type DigestActionRow = typeof schema.digestActions.$inferSelect;

export type DigestView = {
  id: string;
  locationId: string;
  periodStart: Date;
  periodEnd: Date;
  status: "pending" | "ready" | "failed";
  pulseScore: number | null;
  pulseDelta: number | null;
  reviewCount: number;
  locale: string | null;
  generatedAt: Date | null;
  payload: DigestPayload | null;
  actions: DigestActionRow[];
};

function toView(row: typeof schema.digests.$inferSelect, actions: DigestActionRow[]): DigestView {
  return {
    id: row.id,
    locationId: row.locationId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    pulseScore: row.pulseScore,
    pulseDelta: row.pulseDelta,
    reviewCount: row.reviewCount,
    locale: row.locale,
    generatedAt: row.generatedAt,
    payload: (row.payload as DigestPayload | null) ?? null,
    actions,
  };
}

/**
 * The newest ready digest for a location — what Home renders.
 *
 * `ready` only: a pending row is a job in flight and a failed one is an
 * incident, and showing either as "your week" would be worse than showing the
 * previous week with its own date on it.
 */
export async function latestDigest(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
): Promise<DigestView | null> {
  const [row] = await tx
    .select()
    .from(schema.digests)
    .where(
      and(
        eq(schema.digests.organizationId, organizationId),
        eq(schema.digests.locationId, locationId),
        eq(schema.digests.status, "ready"),
      ),
    )
    .orderBy(desc(schema.digests.periodStart))
    .limit(1);

  if (!row) return null;

  const actions = await tx
    .select()
    .from(schema.digestActions)
    .where(
      and(
        eq(schema.digestActions.organizationId, organizationId),
        eq(schema.digestActions.digestId, row.id),
      ),
    )
    .orderBy(asc(schema.digestActions.position));

  return toView(row, actions);
}

/**
 * One digest by id — the archive's detail view.
 *
 * Unlike `latestDigest` this accepts any status. The archive is a record of
 * what was composed, and a failed week that silently 404s is worse than one
 * that says it failed: the reader knows a briefing was due and needs to know
 * where it went.
 *
 * Tenant-scoped through `tx` like every other read, so an id guessed from
 * another organization returns null rather than a digest.
 */
export async function digestById(
  tx: TenantDatabase,
  organizationId: string,
  digestId: string,
): Promise<DigestView | null> {
  const [row] = await tx
    .select()
    .from(schema.digests)
    .where(and(eq(schema.digests.organizationId, organizationId), eq(schema.digests.id, digestId)))
    .limit(1);

  if (!row) return null;

  const actions = await tx
    .select()
    .from(schema.digestActions)
    .where(
      and(
        eq(schema.digestActions.organizationId, organizationId),
        eq(schema.digestActions.digestId, row.id),
      ),
    )
    .orderBy(asc(schema.digestActions.position));

  return toView(row, actions);
}

/**
 * How the digest for one week is getting on.
 *
 * `"none"` and `"pending"` are different answers to different questions —
 * nothing has been asked for yet, versus a worker is composing right now — and
 * the Home screen's button needs to tell them apart to know whether to keep
 * watching. `generatedAt` distinguishes a *re*generation that is still running
 * (a previous composition's timestamp, status back to `pending`) from a first
 * one that has never produced anything.
 */
export type DigestProgress = {
  status: "none" | "pending" | "ready" | "failed";
  generatedAt: Date | null;
};

export async function digestProgress(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  periodStart: Date,
): Promise<DigestProgress> {
  const [row] = await tx
    .select({ status: schema.digests.status, generatedAt: schema.digests.generatedAt })
    .from(schema.digests)
    .where(
      and(
        eq(schema.digests.organizationId, organizationId),
        eq(schema.digests.locationId, locationId),
        eq(schema.digests.periodStart, periodStart),
      ),
    )
    .limit(1);

  return row
    ? { status: row.status, generatedAt: row.generatedAt }
    : { status: "none", generatedAt: null };
}

/** Recent digests for a location, newest first — the history strip. */
export async function listDigests(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
  limit = 12,
): Promise<
  Pick<
    DigestView,
    "id" | "periodStart" | "periodEnd" | "pulseScore" | "pulseDelta" | "reviewCount" | "status"
  >[]
> {
  return tx
    .select({
      id: schema.digests.id,
      periodStart: schema.digests.periodStart,
      periodEnd: schema.digests.periodEnd,
      pulseScore: schema.digests.pulseScore,
      pulseDelta: schema.digests.pulseDelta,
      reviewCount: schema.digests.reviewCount,
      status: schema.digests.status,
    })
    .from(schema.digests)
    .where(
      and(
        eq(schema.digests.organizationId, organizationId),
        eq(schema.digests.locationId, locationId),
      ),
    )
    .orderBy(desc(schema.digests.periodStart))
    .limit(limit);
}

/**
 * Marks a recommended action done or dismissed.
 *
 * This is the write that closes the loop: the next digest reads these statuses
 * and reports what happened. Idempotent — re-marking a done action changes
 * nothing rather than moving its completion time.
 */
export async function setActionStatus(
  tx: TenantDatabase,
  input: {
    organizationId: string;
    actionId: string;
    status: "open" | "done" | "dismissed";
    userId: string;
    now?: Date;
  },
): Promise<DigestActionRow | null> {
  const now = input.now ?? new Date();
  const closing = input.status !== "open";

  const [row] = await tx
    .update(schema.digestActions)
    .set({
      status: input.status,
      completedByUserId: closing ? input.userId : null,
      completedAt: closing ? now : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.digestActions.organizationId, input.organizationId),
        eq(schema.digestActions.id, input.actionId),
      ),
    )
    .returning();

  return row ?? null;
}
