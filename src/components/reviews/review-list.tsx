import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Stars } from "@/components/ds/stars";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ReplyComposer, type ReplyState } from "@/components/reviews/reply-composer";
import { TriageBar, type AssigneeOption } from "@/components/reviews/triage-bar";
import type { ReplyAffordance } from "@/connectors/capability-view";
import type { ReviewStatus } from "@/db/schema";
import type { SlaState } from "@/reviews/workflow";
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
  /** Canonical themes (W3.2); often empty — no backfill. */
  themes: string[];
  /** Team triage state (P2-T4). */
  status: ReviewStatus;
  assigneeUserId: string | null;
  sla: SlaState;
  slaDueAt: Date | null;
};

export type ReviewListOptions = {
  /** False when the plan has no `ai_replies`. */
  canUseAi: boolean;
  /** False for a member — approve and post are admin-only. */
  canApprove: boolean;
  /** The review a deep link asked for, outlined so it can be found. */
  highlightId?: string | null;
  /** Who this location's work may be given to (P2-T4). */
  assignees: AssigneeOption[];
  /** False for a client, whose role reads but does not run the queue. */
  canTriage: boolean;
  /**
   * False when the plan has no `bulk_actions`, or the role cannot act.
   *
   * A checkbox with no bar to act on it is worse than no checkbox: it invites a
   * selection and then does nothing with it.
   */
  /**
   * The active branch's sign-off (W5-12), or null when it has none.
   *
   * On the options rather than on each review: this screen resolves exactly one
   * location, so a per-review copy would be the same string repeated down the
   * page — and the day the queue spans branches it becomes a review-level field
   * in one edit, which is the moment it genuinely differs per row.
   */
  replySignature?: string | null;
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
  // Indigo used to carry "positive" here. Indigo means "this is interactive" in
  // this system and nothing else — a green chip beside a blue reply button is
  // the difference between a reading and a control (docs/15 §Colour).
  return <Badge variant={sentiment === "neutral" ? "rating" : sentiment}>{label}</Badge>;
}

/**
 * Amber stars, the one place the accent colour is spent.
 *
 * Typographic ★☆ rather than five repeated Lucide SVGs — same glyph as Home's
 * queue, and it inherits colour and size instead of needing both set on five
 * separate nodes per row (docs/15 §Components).
 */
function Rating({ rating, label }: { rating: number | null; label: string }) {
  if (rating === null) {
    return <span className="text-meta text-faint">{label}</span>;
  }

  return <Stars rating={rating} srLabel={label} className="text-state-rating-text" />;
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
        // Anchor target: Home's needs-attention queue links here with
        // `#review-<id>`, so the browser scrolls the card into view without a
        // single-review route existing. `scroll-mt` keeps it clear of the
        // sticky header rather than tucked underneath it.
        <li
          key={review.id}
          id={`review-${review.id}`}
          data-review-highlight={review.id === options.highlightId ? "true" : undefined}
          className="scroll-mt-24"
        >
          <Card>
            <CardContent className="space-y-3 py-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {/*
                  No selection checkbox here.

                  This component renders exactly one review — the drawer's
                  detail — and a tick-box beside the single thing you are
                  already looking at selects nothing you could not have selected
                  by being here. It made sense when this card *was* the list;
                  W4.1 moved the list to `ReviewRows` and left the checkbox
                  behind, which is how bulk selection ended up reachable only
                  for one review at a time. It lives in the row now.
                */}
                <span className="font-medium">{review.authorName ?? "—"}</span>
                <Rating
                  rating={review.rating}
                  label={
                    review.rating === null
                      ? t("noRating")
                      : t("ratingLabel", { rating: review.rating })
                  }
                />
                <span className="ml-auto text-copy text-muted-foreground">
                  {review.postedAt ? format.dateTime(review.postedAt, "medium") : null}
                </span>
              </div>

              {review.text ? (
                <p className="text-body leading-relaxed text-pretty">{review.text}</p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2 text-copy text-muted-foreground">
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
                    href={`/reviews?theme=${encodeURIComponent(topic)}`}
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
                  signature={options.replySignature ?? null}
                  /*
                    Open already when a reply is owed.

                    This card is the drawer's detail, opened to answer one
                    review — and the composer sat collapsed behind a button that
                    could only ever be pressed. Not when the owner has already
                    replied: that review is opened to check what was said, and a
                    waiting cursor invites a second reply nobody asked for.
                  */
                  openByDefault={!review.hasOwnerReply && review.reply_ === null}
                />
              ) : null}

              {/*
                Triage sits below the reply, not above it. The reply is what the
                card is *for*; status and assignment are what happens to it
                afterwards, and putting two dropdowns above the customer's words
                would make every card open with administration.
              */}
              <TriageBar
                reviewId={review.id}
                status={review.status}
                assigneeUserId={review.assigneeUserId}
                sla={review.sla}
                dueAt={review.slaDueAt ? format.dateTime(review.slaDueAt, "medium") : null}
                assignees={options.assignees}
                canTriage={options.canTriage}
              />
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
