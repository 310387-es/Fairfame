import { Activity, CornerUpLeft, Send, Star } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import type { ComponentType } from "react";
import { WidgetCard } from "@/components/home/widget-card";
import { describeProvider } from "@/connectors/capability-view";
import type { ActivityItem, ActivityKind } from "@/dashboard/activity";

/**
 * What just happened (widget 10).
 *
 * Three event kinds in one column, newest first, each stating what arrived and
 * from where. No links: every item already has a home elsewhere on the page —
 * a new review is in the queue or the Inbox — and a feed of six links is a
 * navigation menu pretending to be news.
 */

const ICONS: Record<ActivityKind, ComponentType<{ className?: string }>> = {
  review: Star,
  reply: CornerUpLeft,
  request: Send,
};

const TONES: Record<ActivityKind, string> = {
  review: "bg-rating/15 text-rating-ink",
  reply: "bg-primary/10 text-primary",
  request: "bg-positive/12 text-positive-ink",
};

export async function ActivityFeed({ items }: { items: ActivityItem[] }) {
  const [t, format] = await Promise.all([getTranslations("home.activity"), getFormatter()]);

  return (
    <WidgetCard title={t("title")} icon={Activity}>
      {items.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {items.map((item) => {
            const Icon = ICONS[item.kind];
            const source = describeProvider(item.source)?.label ?? item.source;

            return (
              <li key={item.id} className="flex items-start gap-2.5 py-2">
                <span
                  className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-md ${TONES[item.kind]}`}
                >
                  <Icon className="size-3" aria-hidden />
                </span>

                <p className="min-w-0 flex-1 text-xs leading-relaxed">
                  {item.kind === "review"
                    ? item.rating !== null
                      ? t("newRating", { rating: item.rating, source })
                      : t(`newItem.${item.itemType}`, { source })
                    : item.kind === "reply"
                      ? t("replied", { source })
                      : t("requestSent", { channel: source })}
                </p>

                <time
                  dateTime={item.at.toISOString()}
                  className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground"
                >
                  {format.relativeTime(item.at, new Date())}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetCard>
  );
}

export function ActivityFeedSkeleton() {
  return (
    <div className="rounded-2xl bg-card p-4 shadow-sm ring-1 ring-foreground/10" aria-hidden>
      <span className="mb-3 block h-4 w-28 animate-pulse rounded bg-muted" />
      {[0, 1, 2, 3].map((row) => (
        <span key={row} className="mb-2 block h-4 w-full animate-pulse rounded bg-muted" />
      ))}
    </div>
  );
}
