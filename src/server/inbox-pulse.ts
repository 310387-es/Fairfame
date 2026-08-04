"use server";

import { requireActor } from "@/auth/session";
import { parseInboxFilters } from "@/inbox/filters";
import { countInbox, toInboxFilters } from "@/inbox/queries";
import {
  listLocationsForActor,
  readActiveLocationCookie,
  resolveActiveLocation,
} from "@/lib/active-location";
import { childLogger } from "@/lib/logger";
import { withTenant } from "@/lib/tenancy";

/**
 * "Has anything changed?" (P2-T7).
 *
 * The cheapest possible question, asked on a timer, so the expensive answer —
 * re-rendering the inbox — only happens when it would show something new.
 *
 * Polling rather than a stream. A WebSocket or SSE endpoint would mean a second
 * long-lived connection per open tab, a Redis fan-out to carry ingest events
 * across processes, and a reconnection story — real infrastructure, for a feed
 * whose events arrive on a sync interval measured in minutes. A count every
 * thirty seconds is one indexed query and no new moving parts, and it is
 * *correct* in the case a stream is worst at: a tab that was asleep for an hour
 * catches up on its first tick rather than having missed every event.
 *
 * It counts **under the reader's current filters**, which is what makes the
 * signal meaningful. "Three new reviews" while looking at overdue negatives
 * should mean three new overdue negatives, not three new anything.
 */

const log = childLogger({ module: "server/inbox-pulse" });

export type InboxPulse = {
  /** How many rows currently match. Null when there is no location to read. */
  matching: number | null;
};

export async function inboxPulseAction(input: {
  params: Record<string, string>;
}): Promise<InboxPulse> {
  try {
    const actor = await requireActor();
    const cookieValue = await readActiveLocationCookie();
    const filters = parseInboxFilters(input.params);

    return await withTenant(
      { organizationId: actor.organizationId, userId: actor.userId },
      async (tx) => {
        const active = resolveActiveLocation(await listLocationsForActor(tx, actor), cookieValue);
        if (!active) return { matching: null };

        return {
          matching: await countInbox(
            tx,
            actor.organizationId,
            active.id,
            toInboxFilters(filters, { userId: actor.userId }),
          ),
        };
      },
    );
  } catch (error) {
    // A failed poll must never surface. The inbox on screen is still correct;
    // it is only *possibly* stale, and an error toast every thirty seconds
    // would be far worse than a quiet retry on the next tick.
    log.warn({ err: error }, "inboxPulse failed");
    return { matching: null };
  }
}
