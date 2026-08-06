import { CalendarRange, ChevronRight } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { requireActor } from "@/auth/session";
import { GenerateDigestButton } from "@/components/digest/generate-button";
import { Delta } from "@/components/ds/metric";
import { IconTile } from "@/components/ds/icon-tile";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { listDigests } from "@/digest/queries";
import {
  listLocationsForActor,
  readActiveLocationCookie,
  resolveActiveLocation,
} from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";

/**
 * The digest archive (D2 — docs/14-digest-surfaces.md).
 *
 * The weekly briefing's home now that Home is a live dashboard. The two answer
 * different questions and the split is the point: Home says what is happening
 * right now, and this says what a completed week added up to and what was
 * recommended about it.
 *
 * A list rather than a single "latest" screen, because the digest's whole claim
 * is that it closes a loop — an owner marks an action done and the next week
 * reports on it. That only means anything if last week is still reachable.
 *
 * **One card, not one card per week.** Twelve bordered boxes each holding two
 * numbers made every row cost the same glance and left 85% of the width empty;
 * `docs/15` §2 puts rows inside a card and separates them with `--line-soft`.
 * The pulse is named once in the card header rather than labelled on every row.
 */
export default async function DigestArchivePage() {
  const [t, format, actor] = await Promise.all([
    getTranslations("digest"),
    getFormatter(),
    requireActor(),
  ]);
  const cookieValue = await readActiveLocationCookie();

  const { activeLocation, digests } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const active = resolveActiveLocation(await listLocationsForActor(tx, actor), cookieValue);

      return {
        activeLocation: active,
        digests: active ? await listDigests(tx, actor.organizationId, active.id) : [],
      };
    },
  );

  if (!activeLocation) {
    return (
      <>
        <PageHeader title={t("archiveTitle")} />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
            <p className="max-w-sm text-body text-pretty text-muted-foreground">
              {t("noLocation")}
            </p>
            <Button asChild size="sm">
              <Link href="/locations">{t("noLocationAction")}</Link>
            </Button>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t("archiveTitle")}
        subtitle={t("archiveSubtitle", { location: activeLocation.name })}
        action={
          <GenerateDigestButton
            locationId={activeLocation.id}
            label={t("generate")}
            composingLabel={t("composing")}
            slowLabel={t("composeSlow")}
            failedLabel={t("composeFailed")}
          />
        }
      />

      {digests.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
            <IconTile icon={CalendarRange} tone="muted" size="lg" />
            <p className="max-w-sm text-body text-pretty text-muted-foreground">{t("empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <SectionCard
          title={t("archiveListTitle")}
          icon={CalendarRange}
          // The pulse column is named once here rather than on every row —
          // twelve repetitions of the same label is noise, not clarity.
          meta={t("archiveListMeta")}
          flush
        >
          <ul className="border-t border-line-soft">
            {digests.map((digest) => {
              // The stored end is exclusive; a reader counting "28 July – 4
              // August" as a week would get eight days.
              const inclusiveEnd = new Date(digest.periodEnd.getTime() - 1);
              const period = `${format.dateTime(digest.periodStart, {
                day: "numeric",
                month: "short",
              })} – ${format.dateTime(inclusiveEnd, { day: "numeric", month: "short" })}`;

              const row = (
                <DigestRow
                  period={period}
                  delta={digest.pulseDelta}
                  reviewLabel={t("reviewCount", { count: digest.reviewCount })}
                  deltaLabel={
                    digest.pulseDelta === null || digest.pulseDelta === 0
                      ? t("flat")
                      : digest.pulseDelta > 0
                        ? t("up")
                        : t("down")
                  }
                  // Magnitude only: the arrow in `Delta` carries the sign, and
                  // "▼ −21,2" reads as a double negative (docs/15 §7). The unit
                  // is named so a 21-point move is not read as 21%.
                  deltaValue={
                    digest.pulseDelta === null || digest.pulseDelta === 0
                      ? null
                      : t("points", {
                          value: format.number(Math.abs(digest.pulseDelta), {
                            maximumFractionDigits: 1,
                          }),
                        })
                  }
                  pulseValue={
                    digest.pulseScore === null
                      ? null
                      : format.number(digest.pulseScore, { maximumFractionDigits: 0 })
                  }
                  statusLabel={
                    digest.status === "ready"
                      ? null
                      : t(digest.status === "pending" ? "statusPending" : "statusFailed")
                  }
                />
              );

              return (
                <li key={digest.id} className="border-b border-line-soft last:border-b-0">
                  {/* A failed or still-composing week is listed but not linked:
                      there is no briefing behind it to open, and a link that
                      lands on an empty page is worse than one plainly not
                      ready yet. */}
                  {digest.status === "ready" ? (
                    <Link
                      href={`/weekly-plan/${digest.id}`}
                      // Named for assistive technology: the row's own text is a
                      // date and two numbers, which announces as gibberish.
                      aria-label={t("openWeek", { period })}
                      className="block transition-colors hover:bg-surface-sunken focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      {row}
                    </Link>
                  ) : (
                    row
                  )}
                </li>
              );
            })}
          </ul>
        </SectionCard>
      )}
    </>
  );
}

/**
 * One week in the list.
 *
 * The pulse is a row figure rather than a `Metric`: `text-metric` is 28px and
 * exists for a headline number, and twelve of them stacked is twelve focal
 * points. Geist Mono with `tabular-nums` keeps the column from shuffling
 * sideways as the digits change, which is the actual job here.
 */
function DigestRow({
  period,
  pulseValue,
  delta,
  deltaValue,
  deltaLabel,
  reviewLabel,
  statusLabel,
}: {
  period: string;
  pulseValue: string | null;
  delta: number | null;
  deltaValue: string | null;
  deltaLabel: string;
  reviewLabel: string;
  statusLabel: string | null;
}) {
  return (
    <div className="flex items-center gap-4 px-(--card-px) py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-title">{period}</p>
        <p className="mt-0.5 text-meta text-faint">{reviewLabel}</p>
      </div>

      {statusLabel ? (
        <Badge variant="secondary">{statusLabel}</Badge>
      ) : (
        <>
          {/* Fixed columns so the numbers line up down the list rather than
              drifting with the width of each date. */}
          <span className="w-10 text-right font-mono text-title tabular-nums">
            {pulseValue ?? "—"}
          </span>

          <span className="w-24 text-right">
            {deltaValue ? (
              // Up is good for a reputation pulse, so `direction` is the sign —
              // but it is stated as a word for assistive technology, because
              // colour and an arrow glyph are not enough on their own.
              <Delta direction={delta !== null && delta > 0} label={deltaLabel}>
                {deltaValue}
              </Delta>
            ) : null}
          </span>

          <ChevronRight className="size-4 shrink-0 text-graphic-faint" aria-hidden />
        </>
      )}
    </div>
  );
}
