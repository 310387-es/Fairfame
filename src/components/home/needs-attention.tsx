import { AlertTriangle, ArrowRight } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { SectionCard } from "@/components/ds/section-card";
import { Stars } from "@/components/ds/stars";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { AttentionRow } from "@/dashboard/attention";
import { describeProvider } from "@/connectors/capability-view";

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
    // The one card on the page with a red tile. It is the only block here that
    // is asking for something rather than reporting, and the tone says so
    // before the title is read.
    <SectionCard
      title={t("title")}
      icon={AlertTriangle}
      tone="negative"
      link={{ href: "/inbox?reply=unanswered", label: t("all") }}
      flush
      className="overflow-hidden"
    >
      {rows.length === 0 ? (
        // A true empty state, not a placeholder. Nothing waiting is the best
        // possible reading of this card.
        <p className="px-(--card-px) py-6 text-center text-copy text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="flex flex-col border-t border-line-inner">
          {rows.map((row) => {
            const provider = describeProvider(row.source);

            return (
              <li key={row.reviewId} className="border-b border-line-soft last:border-b-0">
                <Link
                  // `review=` so the Inbox opens on the page that actually
                  // holds this row, marks it and scrolls to it. At twenty per
                  // page a bare anchor lands on page one and finds nothing.
                  href={`/inbox?sentiment=negative&reply=unanswered&review=${row.reviewId}`}
                  className="group flex flex-col gap-1.5 px-(--card-px) py-3 transition-colors hover:bg-surface-sunken focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:-outline-offset-1 focus-visible:outline-none"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {row.rating !== null ? (
                      <Stars
                        rating={row.rating}
                        srLabel={t("stars", { count: row.rating })}
                        className="text-state-rating-text"
                      />
                    ) : null}

                    {row.sentiment === "negative" ? (
                      <Badge variant="negative">{t("negative")}</Badge>
                    ) : null}

                    {/* An Instagram comment is not a review, and the queue
                        should not imply someone left stars when they did not. */}
                    {row.itemType !== "review" ? (
                      <Badge variant="outline">{t(`itemType.${row.itemType}`)}</Badge>
                    ) : null}

                    <span className="ml-auto text-meta text-faint">
                      {provider?.label ?? row.source}
                      <span aria-hidden> · </span>
                      <time dateTime={row.at.toISOString()}>
                        {format.relativeTime(row.at, new Date())}
                      </time>
                    </span>
                  </div>

                  <p className="text-copy text-pretty text-ink-600 group-hover:text-foreground">
                    {preview(row.text) ?? t("noText")}
                  </p>

                  <span className="inline-flex items-center gap-1 text-meta font-semibold text-primary">
                    {t("reply")}
                    <ArrowRight className="size-3" aria-hidden />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

export function NeedsAttentionSkeleton() {
  return (
    <Card className="gap-0" aria-hidden>
      <span className="mx-(--card-px) block h-4 w-32 animate-pulse rounded bg-muted" />
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="mt-3 flex flex-col gap-1.5 border-t border-line-soft px-(--card-px) pt-3"
        >
          <span className="h-3 w-40 animate-pulse rounded bg-muted" />
          <span className="h-3 w-full animate-pulse rounded bg-muted" />
        </div>
      ))}
    </Card>
  );
}
