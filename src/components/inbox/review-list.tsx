import { ExternalLink, Star } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ReplyComposer, type ReplyState } from "@/components/inbox/reply-composer";
import type { ReplyAffordance } from "@/connectors/capability-view";
import { cn } from "@/lib/utils";
import { MAX_REPLY_CHARS } from "@/prompts/index";

export type InboxReview = {
  id: string;
  authorName: string | null;
  rating: number | null;
  text: string | null;
  language: string | null;
  postedAt: Date | null;
  source: string;
  hasOwnerReply: boolean;
  /** Where the review lives on the platform, when the source gives us a link. */
  url: string | null;
  /**
   * What this source allows, read from its connector's declared capabilities:
   * `compose` gets a reply box, anything else gets a way out to the platform.
   */
  reply: ReplyAffordance;
  /** Label for the source, e.g. "Google Business Profile". */
  sourceLabel: string;
  /** The live reply for this review, if one has been started. */
  reply_: ReplyState;
  /** From `review_insights`. Null until analysis has run.  */
  sentiment: "positive" | "neutral" | "negative" | null;
  topics: string[];
};

export type ReviewListOptions = {
  /** False when the plan has no `ai_replies`. */
  canUseAi: boolean;
  /** False for a member — approve and post are admin-only. */
  canApprove: boolean;
};

/**
 * The analysis, as a chip.
 *
 * Colour *and* a word, never colour alone — the difference between a positive
 * and a negative review must survive a monochrome screenshot and a reader who
 * cannot distinguish the two hues.
 */
function SentimentChip({
  sentiment,
  label,
}: {
  sentiment: "positive" | "neutral" | "negative";
  label: string;
}) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[11px] font-medium",
        sentiment === "positive"
          ? "bg-primary/10 text-primary"
          : sentiment === "negative"
            ? "bg-destructive/10 text-destructive"
            : "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

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

/**
 * The Inbox stream.
 *
 * The per-review action is chosen by capability, never by provider name: a
 * source that declares `reply: 'api'` gets a composer, and one that cannot
 * reply through an API gets "Open on platform" instead of a box that would
 * post into nothing (docs/03 §4).
 */
export async function ReviewList({
  reviews,
  options,
}: {
  reviews: InboxReview[];
  options: ReviewListOptions;
}) {
  const [t, ts, format] = await Promise.all([
    getTranslations("inbox"),
    getTranslations("sources"),
    getFormatter(),
  ]);

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
                {review.sentiment ? (
                  <SentimentChip
                    sentiment={review.sentiment}
                    label={
                      review.sentiment === "positive"
                        ? t("sentimentPositive")
                        : review.sentiment === "negative"
                          ? t("sentimentNegative")
                          : t("sentimentNeutral")
                    }
                  />
                ) : null}

                {/*
                  Themes are links, not labels: seeing "servis" on three cards
                  and being able to click through to every review about it is
                  the whole point of extracting them.
                */}
                {review.topics.slice(0, 4).map((topic) => (
                  <Link
                    key={topic}
                    href={`/inbox?theme=${encodeURIComponent(topic)}`}
                    className="rounded bg-accent px-1.5 py-0.5 text-accent-foreground underline-offset-2 hover:underline"
                  >
                    {topic}
                  </Link>
                ))}

                <span className="rounded bg-muted px-1.5 py-0.5 font-medium">
                  {review.sourceLabel}
                </span>
                {review.language ? <span className="uppercase">{review.language}</span> : null}
                {review.hasOwnerReply ? <span>· {t("ownerReplied")}</span> : null}

                <span className="ml-auto flex items-center gap-2">
                  {review.reply === "compose" ? null : review.url ? (
                    <Button asChild size="sm" variant="ghost">
                      <a href={review.url} target="_blank" rel="noreferrer nofollow">
                        <ExternalLink className="size-4" aria-hidden />
                        {ts("openOnPlatform")}
                      </a>
                    </Button>
                  ) : null}
                </span>
              </div>

              {/*
                The composer appears only where the source declares it can post
                a reply through its API — the same capability check that decides
                the "Open on platform" fallback above (docs/03 §4).
              */}
              {review.reply === "compose" ? (
                <ReplyComposer
                  reviewId={review.id}
                  reply={review.reply_}
                  canUseAi={options.canUseAi}
                  canApprove={options.canApprove}
                  maxChars={MAX_REPLY_CHARS}
                />
              ) : null}
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
