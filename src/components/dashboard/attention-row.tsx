"use client";

import { ArrowRight, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Stars } from "@/components/ds/stars";
import { useAction } from "@/components/ui/use-action";
import { draftReplyAction } from "@/server/replies";

/**
 * One row of the attention queue, with the AI draft in it (W4.3).
 *
 * ## The button this replaces
 *
 * The old row said "Reply" and navigated, and its own comment explained why:
 * the mock said "AI reply", pressing it drafted nothing, and *"a button that
 * promises generation and delivers navigation is the kind of small lie that
 * costs trust the second time someone notices"*. That reasoning was right. The
 * fix is not to keep the honest label forever — it is to make the button do the
 * thing, which is what this does.
 *
 * ## It drafts; it never posts
 *
 * `draftReplyAction` is `member` and writes a `draft`. Approving and posting
 * are `admin` and live in the Inbox, where the reply is beside the review it
 * answers and a person can read it whole. One click on a dashboard must never
 * be one click from a customer's screen — that is the same rule
 * `src/reviews/bulk.ts` is built on, and `tests/lib/bulk-guardrail.test.ts`
 * exists to keep it.
 *
 * The draft appears **in the row** rather than as a toast, because the point is
 * to read it: a notification saying "draft ready" somewhere else is a
 * navigation with extra steps. Editing still happens in the Inbox, one link
 * away, and the row says so.
 */

export type AttentionRowView = {
  reviewId: string;
  href: string;
  rating: number | null;
  ratingLabel: string | null;
  negative: boolean;
  itemTypeLabel: string | null;
  themes: string[];
  branchName: string | null;
  sourceLabel: string;
  at: string;
  atLabel: string;
  preview: string;
  /**
   * Somebody has already written a reply to this one (A22-A4).
   *
   * The row is here because the *customer* has not heard back, which a draft
   * does not change. What it changes is the offer: writing a second draft over
   * a colleague's is the collision the old rule avoided by hiding the review
   * altogether — at the cost of losing it from every list when the draft was
   * never sent. Saying so and pointing at the existing one costs nothing.
   */
  drafted: boolean;
};

export function AttentionRow({ row }: { row: AttentionRowView }) {
  const t = useTranslations("home.attention");
  const { run, pending } = useAction();
  const [draft, setDraft] = useState<string | null>(null);

  const generate = () => {
    void run(() => draftReplyAction({ reviewId: row.reviewId }), {
      success: t("drafted"),
      onSuccess: (result) => setDraft(result?.text ?? null),
    });
  };

  return (
    <li className="border-b border-line-soft last:border-b-0">
      <div className="flex flex-col gap-1.5 px-(--card-px) py-3">
        <div className="flex flex-wrap items-center gap-2">
          {row.rating !== null ? (
            <Stars
              rating={row.rating}
              srLabel={row.ratingLabel ?? ""}
              className="text-state-rating-text"
            />
          ) : null}

          {row.negative ? <Badge variant="negative">{t("negative")}</Badge> : null}

          {/* An Instagram comment is not a review, and the queue should not
              imply someone left stars when they did not. */}
          {row.itemTypeLabel ? <Badge variant="outline">{row.itemTypeLabel}</Badge> : null}

          <span className="ml-auto text-meta text-faint">
            {row.branchName ? (
              <>
                {row.branchName}
                <span aria-hidden> · </span>
              </>
            ) : null}
            {row.sourceLabel}
            <span aria-hidden> · </span>
            <time dateTime={row.at}>{row.atLabel}</time>
          </span>
        </div>

        <Link
          href={row.href}
          className="text-copy text-pretty text-ink-600 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {row.preview}
        </Link>

        {/*
          What the complaint is *about*, not just that there was one.

          Canonical keys through the shared taxonomy, already translated on the
          server — so "servis" and "service" are one chip, and a reader scanning
          four rows sees the pattern before opening any of them.
        */}
        {row.themes.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {row.themes.map((theme) => (
              <span
                key={theme}
                className="rounded-full bg-surface-sunken px-2 py-0.5 text-meta text-ink-500"
              >
                {theme}
              </span>
            ))}
          </div>
        ) : null}

        {draft === null && row.drafted ? (
          // A draft exists and has not gone out. The work left is to read it
          // and send it, so that is the only thing offered.
          <div className="mt-0.5 flex flex-wrap items-center gap-3">
            <span className="text-meta font-semibold text-state-rating-text">
              {t("draftWaiting")}
            </span>
            <Link
              href={row.href}
              className="inline-flex items-center gap-1 text-meta font-semibold text-primary hover:underline"
            >
              {t("editAndSend")}
              <ArrowRight className="size-3" aria-hidden />
            </Link>
          </div>
        ) : draft === null ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" onClick={generate} disabled={pending}>
              <Sparkles className="size-3.5" aria-hidden />
              {pending ? t("drafting") : t("draftWithAi")}
            </Button>

            <Link
              href={row.href}
              className="inline-flex items-center gap-1 text-meta font-semibold text-primary hover:underline"
            >
              {t("open")}
              <ArrowRight className="size-3" aria-hidden />
            </Link>
          </div>
        ) : (
          <div className="mt-1 rounded-md border border-line bg-surface-sunken px-3 py-2">
            <p className="text-meta text-faint">{t("draftLabel")}</p>
            <p className="mt-1 text-copy text-pretty text-ink-600">{draft}</p>
            <Link
              href={row.href}
              className="mt-2 inline-flex items-center gap-1 text-meta font-semibold text-primary hover:underline"
            >
              {t("editAndSend")}
              <ArrowRight className="size-3" aria-hidden />
            </Link>
          </div>
        )}
      </div>
    </li>
  );
}
