"use server";

import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { childLogger } from "@/lib/logger";
import {
  readActiveLocationCookie,
  listLocationsForActor,
  resolveActiveLocation,
} from "@/lib/active-location";
import { search } from "@/search/queries";
import { MIN_QUERY_LENGTH, type SearchResults } from "@/search/types";

/**
 * The command palette's one action.
 *
 * A server action rather than a route handler: it inherits the session and the
 * tenant transaction exactly like every other mutation-free read in the app, so
 * there is no second place where "is this person allowed to see this?" has to
 * be answered. A `/api/search` endpoint would need that logic written again.
 *
 * The location is resolved here from the same cookie the Inbox reads, never
 * taken from the client. A location id in the payload would let any member
 * search a location they cannot open — RLS would not stop it, because both
 * locations belong to the same organization.
 */

const log = childLogger({ module: "server/search" });

const schema = z.object({ query: z.string().min(MIN_QUERY_LENGTH).max(200) });

const EMPTY: SearchResults = { reviews: [], themes: [], hasMore: false };

export async function searchAction(input: { query: string }): Promise<SearchResults> {
  const parsed = schema.safeParse(input);
  // Too short or too long is not an error worth surfacing — the palette simply
  // has nothing to show yet.
  if (!parsed.success) return EMPTY;

  try {
    return await withAuthenticatedTenant(async (tx, actor) => {
      const active = resolveActiveLocation(
        await listLocationsForActor(tx, actor),
        await readActiveLocationCookie(),
      );

      if (!active) return EMPTY;

      return await search(tx, actor.organizationId, active.id, parsed.data.query);
    });
  } catch (error) {
    // A failed search should quietly show nothing rather than break the shell
    // it is rendered inside — but it must still reach the logs.
    log.error({ err: error }, "Search failed");
    return EMPTY;
  }
}
