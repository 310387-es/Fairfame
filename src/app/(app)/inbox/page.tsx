import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { InboxFilterBar, type InboxFilterState } from "@/components/inbox/filter-bar";
import { ReviewList, type InboxReview } from "@/components/inbox/review-list";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { describeProvider } from "@/connectors/capability-view";
import type { Sentiment } from "@/db/schema";
import { inboxFacets, listInbox, type ReplyState } from "@/inbox/queries";
import {
  listLocations,
  readActiveLocationCookie,
  resolveActiveLocation,
} from "@/lib/active-location";
import { can } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";

/**
 * The Inbox — every ingested review for the active location, newest first,
 * with its analysis and its reply state.
 *
 * Filters live in the URL rather than in component state, which is what lets a
 * digest action link straight to the reviews behind it (`/inbox?theme=servis`)
 * and lets an owner share "the negative ones from Google" with a colleague.
 */

const SENTIMENTS = ["positive", "neutral", "negative"] as const;
const REPLY_STATES = ["unanswered", "answered"] as const;

/** Query strings are user input; anything unrecognised is simply no filter. */
function parseFilters(params: Record<string, string | string[] | undefined>): InboxFilterState {
  const one = (value: string | string[] | undefined): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

  const sentiment = one(params.sentiment);
  const reply = one(params.reply);

  return {
    source: one(params.source),
    sentiment: (SENTIMENTS as readonly string[]).includes(sentiment ?? "") ? sentiment : null,
    theme: one(params.theme),
    reply: (REPLY_STATES as readonly string[]).includes(reply ?? "") ? reply : null,
  };
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [t, actor, params] = await Promise.all([
    getTranslations("inbox"),
    requireActor(),
    searchParams,
  ]);

  const filters = parseFilters(params);
  const cookieValue = await readActiveLocationCookie();

  const { locations, page, activeLocation, facets, canUseAi } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const allLocations = await listLocations(tx, actor.organizationId);
      const active = resolveActiveLocation(allLocations, cookieValue);

      if (!active) {
        return {
          locations: allLocations,
          activeLocation: null,
          page: { rows: [], hasMore: false },
          facets: null,
          canUseAi: false,
        };
      }

      return {
        locations: allLocations,
        activeLocation: active,
        page: await listInbox(tx, actor.organizationId, active.id, {
          source: filters.source,
          sentiment: filters.sentiment as Sentiment | null,
          theme: filters.theme,
          reply: (filters.reply ?? "any") as ReplyState,
        }),
        facets: await inboxFacets(tx, actor.organizationId, active.id),
        // Server-side, from plan config — never `if plan === '...'`.
        canUseAi: await can({ organizationId: actor.organizationId, tx }, "ai_replies"),
      };
    },
  );

  const items: InboxReview[] = page.rows.map((review) => {
    // Capability comes from the source the row was ingested from, so a mixed
    // inbox offers the right action per review rather than one action for all.
    const view = describeProvider(review.source);

    return {
      id: review.id,
      authorName: review.authorName,
      rating: review.rating,
      text: review.text,
      language: review.language,
      postedAt: review.postedAt,
      source: review.source,
      sourceLabel: view?.label ?? review.source,
      reply: view?.reply ?? "none",
      url: review.url,
      sentiment: review.sentiment,
      topics: review.topics,
      // The provider payload is retained verbatim, so an owner reply made on
      // the platform itself is discoverable even though we did not post it.
      hasOwnerReply:
        typeof review.rawPayload === "object" &&
        review.rawPayload !== null &&
        "ownerReply" in review.rawPayload,
      reply_: review.reply,
    };
  });

  const sourceLabels = Object.fromEntries(
    (facets?.sources ?? []).map((source) => [
      source.value,
      describeProvider(source.value)?.label ?? source.value,
    ]),
  );

  const filtered = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={
          activeLocation ? t("forLocation", { location: activeLocation.name }) : t("subtitle")
        }
      />

      {!activeLocation ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
            <p className="max-w-sm text-sm text-pretty text-muted-foreground">
              {locations.length === 0 ? t("empty") : t("noLocationSelected")}
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/locations">{t("emptyAction")}</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {facets && facets.total > 0 ? (
            <InboxFilterBar facets={facets} filters={filters} sourceLabels={sourceLabels} />
          ) : null}

          <p className="mb-4 text-sm text-muted-foreground">
            {/*
              Three different truths, said differently: a truncated list, a
              filtered one, and the whole thing. Conflating the first two is
              how the screen came to claim "111 of 111" while showing 100.
            */}
            {page.hasMore
              ? t("showingFirst", { shown: items.length })
              : filtered && facets
                ? t("filtered", { shown: items.length, total: facets.total })
                : t("count", { count: items.length })}
          </p>

          {items.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
                <p className="max-w-sm text-sm text-pretty text-muted-foreground">
                  {filtered ? t("noMatches") : t("empty")}
                </p>
                <Button asChild variant="outline" size="sm">
                  <Link href={filtered ? "/inbox" : "/locations"}>
                    {filtered ? t("clearFilters") : t("emptyAction")}
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <ReviewList
              reviews={items}
              options={{
                canUseAi,
                // Approving and posting publish under the business's name, so
                // they need admin. The server enforces the same rule; this only
                // decides whether to render a control that would be refused.
                canApprove: roleAtLeast(actor.role, "admin"),
              }}
            />
          )}
        </>
      )}
    </>
  );
}
