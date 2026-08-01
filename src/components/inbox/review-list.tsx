import { Star } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type InboxReview = {
  id: string;
  authorName: string | null;
  rating: number | null;
  text: string | null;
  language: string | null;
  postedAt: Date | null;
  source: string;
  hasOwnerReply: boolean;
};

/** Amber stars, the one place the accent colour is spent. */
function Rating({ rating, label }: { rating: number | null; label: string }) {
  if (rating === null) {
    return <span className="text-xs text-muted-foreground">{label}</span>;
  }

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

export async function ReviewList({ reviews }: { reviews: InboxReview[] }) {
  const [t, format] = await Promise.all([getTranslations("inbox"), getFormatter()]);

  return (
    <ul className="space-y-3">
      {reviews.map((review) => (
        <li key={review.id}>
          <Card>
            <CardContent className="space-y-3 py-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{review.authorName ?? "—"}</span>
                <Rating
                  rating={review.rating}
                  label={
                    review.rating === null
                      ? t("noRating")
                      : t("ratingLabel", { rating: review.rating })
                  }
                />
                <span className="ml-auto text-xs text-muted-foreground">
                  {review.postedAt ? format.dateTime(review.postedAt, "medium") : null}
                </span>
              </div>

              {review.text ? (
                <p className="text-sm leading-relaxed text-pretty">{review.text}</p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5 font-medium capitalize">
                  {review.source}
                </span>
                {review.language ? <span className="uppercase">{review.language}</span> : null}
                {review.hasOwnerReply ? <span>· {t("ownerReplied")}</span> : null}
              </div>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
