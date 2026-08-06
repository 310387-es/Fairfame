import { AlertTriangle } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { AttentionRow as Row, type AttentionRowView } from "@/components/dashboard/attention-row";
import { SectionCard } from "@/components/ds/section-card";
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
 * **The row's button now drafts** (W4.3). It used to say "Reply" and navigate,
 * on the reasoning that a button promising generation and delivering navigation
 * is a small lie. That was right, and the resolution was never to keep the
 * honest label forever — `AttentionRow` makes the button do the thing. It still
 * only ever writes a *draft*; approving and posting stay in the Inbox.
 *
 * This component stays a server component and does all the formatting, because
 * a formatter cannot cross the RSC boundary — the defect this codebase has met
 * three times now.
 */

const PREVIEW_LENGTH = 120;

function preview(text: string | null): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > PREVIEW_LENGTH ? `${clean.slice(0, PREVIEW_LENGTH).trimEnd()}…` : clean;
}

export async function NeedsAttention({
  rows,
  branchNames,
}: {
  rows: AttentionRow[];
  /**
   * Branch names, but only when more than one branch is in view (W4.3). Empty
   * on a single-branch account, where naming the branch on every row would be
   * the same word four times.
   */
  branchNames: Map<string, string>;
}) {
  const [t, tThemes, format] = await Promise.all([
    getTranslations("home.attention"),
    getTranslations("themes"),
    getFormatter(),
  ]);

  const now = new Date();

  const views: AttentionRowView[] = rows.map((row) => ({
    reviewId: row.reviewId,
    // `review=` so the Inbox opens on the page that actually holds this row,
    // marks it and scrolls to it. At twenty per page a bare anchor lands on
    // page one and finds nothing.
    href: `/reviews?sentiment=negative&reply=unanswered&review=${row.reviewId}`,
    rating: row.rating,
    ratingLabel: row.rating === null ? null : t("stars", { count: row.rating }),
    negative: row.sentiment === "negative",
    itemTypeLabel: row.itemType === "review" ? null : t(`itemType.${row.itemType}`),
    themes: row.themes.map((theme) => tThemes(theme)),
    branchName: branchNames.get(row.locationId) ?? null,
    sourceLabel: describeProvider(row.source)?.label ?? row.source,
    at: row.at.toISOString(),
    atLabel: format.relativeTime(row.at, now),
    preview: preview(row.text) ?? t("noText"),
  }));

  return (
    // The one card on the page with a red tile. It is the only block here that
    // is asking for something rather than reporting, and the tone says so
    // before the title is read.
    <SectionCard
      title={t("title")}
      icon={AlertTriangle}
      tone="negative"
      link={{ href: "/reviews?reply=unanswered", label: t("all") }}
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
          {views.map((view) => (
            <Row key={view.reviewId} row={view} />
          ))}
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
