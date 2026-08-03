import { Activity, CornerUpLeft, Send, Star } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { IconTile } from "@/components/ds/icon-tile";
import { SectionCard } from "@/components/ds/section-card";
import { describeProvider } from "@/connectors/capability-view";
import type { ActivityItem, ActivityKind } from "@/dashboard/activity";

/**
 * What just happened (widget 10).
 *
 * A full-width ticker rather than a column. As a third of a row every entry
 * wrapped onto three lines and the card grew taller than the two beside it to
 * say very little; across the foot of the page the same four events read in one
 * pass and cost one line of height.
 *
 * Three event kinds, newest first, each stating what arrived and from where. No
 * links: every item already has a home elsewhere on the page — a new review is
 * in the queue or the Inbox — and a feed of six links is a navigation menu
 * pretending to be news.
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

export async function ActivityFeed({ items }: { items: ActivityItem[] }) {
  const [t, format] = await Promise.all([getTranslations("home.activity"), getFormatter()]);

  return (
    <SectionCard title={t("title")} icon={Activity}>
      {items.length === 0 ? (
        <p className="py-6 text-center text-copy text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {items.slice(0, 4).map((item, index) => {
            const Icon = ICONS[item.kind];
            const source = describeProvider(item.source)?.label ?? item.source;

            return (
              <li
                key={item.id}
                className={
                  // A hairline between columns, and none after the last —
                  // borders on the item rather than a divider element, so the
                  // grid can wrap without leaving a rule hanging in mid-air.
                  index < 3
                    ? "flex gap-2.5 lg:border-r lg:border-line-soft lg:pr-3.5"
                    : "flex gap-2.5"
                }
              >
                <IconTile icon={Icon} tone={TONES[item.kind]} size="sm" className="mt-0.5" />

                <span className="min-w-0">
                  <span className="block text-copy leading-snug">
                    {item.kind === "review"
                      ? item.rating !== null
                        ? t("newRating", { rating: item.rating, source })
                        : t(`newItem.${item.itemType}`, { source })
                      : item.kind === "reply"
                        ? t("replied", { source })
                        : t("requestSent", { channel: source })}
                  </span>

                  <time
                    dateTime={item.at.toISOString()}
                    className="mt-0.5 block text-meta text-faint"
                  >
                    {format.relativeTime(item.at, new Date())}
                  </time>
                </span>
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
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((row) => (
          <span key={row} className="block h-8 animate-pulse rounded bg-muted" />
        ))}
      </div>
    </div>
  );
}
