import { Activity, CornerUpLeft, Send, Star } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Avatar } from "@/components/ds/avatar";
import { IconTile } from "@/components/ds/icon-tile";
import { SectionCard } from "@/components/ds/section-card";
import { describeProvider } from "@/connectors/capability-view";
import type { ActivityItem, ActivityKind } from "@/dashboard/activity";

/**
 * What just happened (widget 10).
 *
 * **A timeline with people in it** (W4.3). It was four columns across the foot
 * of the page, and on a real account they read like this:
 *
 *   new 5★ review on Google · new 5★ review on Google · new 5★ review on
 *   Google · new 5★ review on Google
 *
 * Four events rendered as one sentence four times, which reads as a bug rather
 * than as news. Nothing was wrong with the query — what was missing was the
 * only field that distinguishes one arrival from another, which is *who*.
 *
 * So: a vertical list, a monogram per entry, the person's name in the sentence,
 * and the branch where more than one is in view. Six entries rather than four,
 * because a column has the room a four-across strip did not.
 *
 * Still no links. Every item already has a home elsewhere on the page — a new
 * review is in the queue or the Inbox — and a feed of six links is a navigation
 * menu pretending to be news.
 */

const ICONS: Record<ActivityKind, typeof Star> = {
  review: Star,
  reply: CornerUpLeft,
  request: Send,
};

/** Tile tone says what kind of event this is, matching the rest of the app. */
const TONES: Record<ActivityKind, "rating" | "accent" | "muted"> = {
  review: "rating",
  reply: "accent",
  request: "muted",
};

export async function ActivityFeed({
  items,
  branchNames,
}: {
  items: ActivityItem[];
  /** Empty on a single-branch view: naming it every line says nothing. */
  branchNames: Map<string, string>;
}) {
  const [t, format] = await Promise.all([getTranslations("home.activity"), getFormatter()]);
  const now = new Date();

  return (
    <SectionCard title={t("title")} icon={Activity}>
      {items.length === 0 ? (
        <p className="py-6 text-center text-copy text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col">
          {items.slice(0, 6).map((item) => {
            const Icon = ICONS[item.kind];
            const source = describeProvider(item.source)?.label ?? item.source;
            const branch = branchNames.get(item.locationId) ?? null;

            const sentence =
              item.kind === "review"
                ? item.rating !== null
                  ? t("newRating", { rating: item.rating, source })
                  : t(`newItem.${item.itemType}`, { source })
                : item.kind === "reply"
                  ? t("replied", { source })
                  : t("requestSent", { channel: source });

            return (
              <li
                key={item.id}
                className="flex items-start gap-2.5 border-b border-line-soft py-2.5 last:border-b-0"
              >
                <Avatar name={item.actorName} />

                {/* Not `flex-1`: stretching the text pushed the kind tile to the
                    far right edge of a full-width card, 700px from the sentence
                    it qualifies, where it read as a stray control rather than
                    as part of the entry. */}
                <span className="min-w-0">
                  <span className="block text-copy leading-snug">
                    {/*
                      The name carries the weight and the event is the
                      predicate — "Zeynep Kaya · new 5★ review on Google" reads
                      as an event, where "new 5★ review on Google · Zeynep
                      Kaya" reads as a row of metadata. An event with nobody
                      behind it (a campaign send) just states itself.
                    */}
                    {item.actorName === null ? null : (
                      <strong className="font-medium text-foreground">{item.actorName} </strong>
                    )}
                    <span className={item.actorName === null ? "text-foreground" : "text-ink-600"}>
                      {sentence}
                    </span>
                  </span>

                  <span className="mt-0.5 flex items-center gap-1.5 text-meta text-faint">
                    {branch ? (
                      <>
                        <span>{branch}</span>
                        <span aria-hidden>·</span>
                      </>
                    ) : null}
                    <time dateTime={item.at.toISOString()}>
                      {format.relativeTime(item.at, now)}
                    </time>
                  </span>
                </span>

                {/* The kind, as the tile it already had — small, beside the
                    sentence, where it qualifies rather than announces. */}
                <IconTile icon={Icon} tone={TONES[item.kind]} size="sm" className="mt-0.5" />
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

export function ActivityFeedSkeleton() {
  return (
    <div
      className="rounded-lg border border-line bg-card px-(--card-px) py-(--card-py)"
      aria-hidden
    >
      <span className="mb-3.5 block h-4 w-28 animate-pulse rounded bg-muted" />
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3].map((row) => (
          <span key={row} className="block h-8 animate-pulse rounded bg-muted" />
        ))}
      </div>
    </div>
  );
}
