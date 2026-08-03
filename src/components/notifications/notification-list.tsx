import { AlertTriangle, Star } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { FeedItem } from "@/notifications/feed";
import { MarkReadButton } from "./mark-read-button";

/**
 * The in-app feed (P1a-T5).
 *
 * Rendered from the notification's stored payload rather than by joining back
 * to the review. A notification is a record of what happened at a moment; if
 * the review is later edited or erased, the alert should still read correctly
 * instead of silently changing or disappearing.
 *
 * Urgent rows are marked with a left border and a badge, not with colour alone
 * — that is the accessibility floor, and the badge also survives a screenshot
 * pasted into a chat.
 */

function Rating({ rating, label }: { rating: number | null; label: string }) {
  if (rating === null) return null;

  return (
    <span className="flex items-center gap-0.5" aria-label={label}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          aria-hidden
          className={cn(
            "size-3.5",
            star <= rating ? "fill-rating text-rating" : "text-muted-foreground/30",
          )}
        />
      ))}
    </span>
  );
}

export async function NotificationList({ items }: { items: FeedItem[] }) {
  const [t, format] = await Promise.all([getTranslations("notifications"), getFormatter()]);

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {t("empty")}
        </CardContent>
      </Card>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => {
        const urgent = item.urgency === "urgent";
        const unread = item.readAt === null;

        return (
          <li key={item.id}>
            <Card
              className={cn(
                "border-l-4 transition-colors",
                urgent ? "border-l-destructive" : "border-l-transparent",
                unread ? "bg-card" : "bg-muted/40",
              )}
            >
              <CardContent className="flex flex-col gap-2 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  {urgent ? (
                    <Badge variant="destructive" className="gap-1">
                      <AlertTriangle className="size-3" aria-hidden />
                      {t("urgent")}
                    </Badge>
                  ) : null}

                  <span className="text-sm font-medium">
                    {urgent
                      ? t("newReviewUrgent", { location: item.payload.locationName })
                      : t("newReview", { location: item.payload.locationName })}
                  </span>

                  <span className="ml-auto text-xs text-muted-foreground">
                    {format.relativeTime(item.createdAt, new Date())}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <Rating
                    rating={item.payload.rating}
                    label={
                      item.payload.rating === null
                        ? ""
                        : t("ratingLabel", { rating: item.payload.rating })
                    }
                  />
                  <span>{item.payload.authorName ?? t("anonymous")}</span>
                  <span aria-hidden>·</span>
                  <span>{item.payload.source}</span>
                </div>

                <p className="text-sm leading-relaxed">
                  {item.payload.excerpt ?? (
                    <span className="text-muted-foreground italic">{t("noText")}</span>
                  )}
                </p>

                <div className="flex items-center gap-3 pt-1">
                  {item.reviewId ? (
                    <Link
                      href={`/inbox?review=${item.reviewId}`}
                      className="text-xs font-medium underline-offset-4 hover:underline"
                    >
                      {t("openReview")}
                    </Link>
                  ) : null}

                  {unread ? <MarkReadButton id={item.id} label={t("markRead")} /> : null}
                </div>
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
