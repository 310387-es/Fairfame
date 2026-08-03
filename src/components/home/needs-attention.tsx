import { AlertTriangle, ArrowRight, Star } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { AttentionRow } from "@/dashboard/attention";
import { describeProvider } from "@/connectors/capability-view";
import { cn } from "@/lib/utils";

/**
 * The queue (Home live dashboard §4, widget 4).
 *
 * Rows link into the Inbox filtered the way the queue was built — negative and
 * unanswered — with an anchor to the specific review. The Inbox has no
 * single-review route, and inventing one to satisfy a link would be a bigger
 * change than the link is worth; an anchor lands on the right card, keeps its
 * neighbours visible, and works without JavaScript.
 *
 * The mock labels the row button "AI reply". This says "Reply", because
 * pressing it does not draft anything — it takes you to where drafting happens.
 * A button that promises generation and delivers navigation is the kind of
 * small lie that costs trust the second time someone notices.
 */

const PREVIEW_LENGTH = 120;

function preview(text: string | null): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > PREVIEW_LENGTH ? `${clean.slice(0, PREVIEW_LENGTH).trimEnd()}…` : clean;
}

export async function NeedsAttention({ rows }: { rows: AttentionRow[] }) {
  const [t, format] = await Promise.all([getTranslations("home.attention"), getFormatter()]);

  return (
    <Card className="rounded-2xl">
      <CardContent className="flex flex-col gap-1">
        <div className="mb-2 flex items-center gap-2">
          <span className="grid size-6.5 place-items-center rounded-lg bg-muted text-muted-foreground">
            <AlertTriangle className="size-3.5" aria-hidden />
          </span>
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <Link
            href="/inbox?reply=unanswered"
            className="ml-auto rounded text-xs font-semibold text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {t("all")}
          </Link>
        </div>

        {rows.length === 0 ? (
          // A true empty state, not a placeholder. Nothing waiting is the best
          // possible reading of this card.
          <p className="py-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) => {
              const provider = describeProvider(row.source);
              const stars = row.rating;

              return (
                <li
                  key={row.reviewId}
                  className="border-t border-border/60 py-3 first:border-t-0 first:pt-0"
                >
                  <Link
                    href={`/inbox?sentiment=negative&reply=unanswered#review-${row.reviewId}`}
                    className="group flex flex-col gap-1.5 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      {stars !== null ? (
                        <span
                          className="inline-flex items-center gap-0.5 text-rating-ink"
                          aria-label={t("stars", { count: stars })}
                        >
                          {Array.from({ length: 5 }, (_, index) => (
                            <Star
                              key={index}
                              className={cn("size-3", index < stars && "fill-current")}
                              aria-hidden
                            />
                          ))}
                        </span>
                      ) : null}

                      {row.sentiment === "negative" ? (
                        <Badge
                          variant="secondary"
                          className="bg-sentiment-negative/12 px-1.5 py-0 text-[10px] font-semibold text-destructive-ink"
                        >
                          {t("negative")}
                        </Badge>
                      ) : null}

                      {/* An Instagram comment is not a review, and the queue
                          should not imply someone left stars when they did not. */}
                      {row.itemType !== "review" ? (
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                          {t(`itemType.${row.itemType}`)}
                        </Badge>
                      ) : null}

                      <span>{provider?.label ?? row.source}</span>
                      <span aria-hidden>·</span>
                      <time dateTime={row.at.toISOString()}>
                        {format.relativeTime(row.at, new Date())}
                      </time>
                    </div>

                    <p className="text-xs leading-relaxed text-pretty group-hover:text-foreground">
                      {preview(row.text) ?? t("noText")}
                    </p>

                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary">
                      {t("reply")}
                      <ArrowRight className="size-3" aria-hidden />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function NeedsAttentionSkeleton() {
  return (
    <Card className="rounded-2xl" aria-hidden>
      <CardContent className="flex flex-col gap-3">
        <span className="h-4 w-32 animate-pulse rounded bg-muted" />
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex flex-col gap-1.5 border-t border-border/60 py-3">
            <span className="h-3 w-40 animate-pulse rounded bg-muted" />
            <span className="h-3 w-full animate-pulse rounded bg-muted" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
