import { CalendarRange, ChevronRight, MapPin } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { requireActor } from "@/auth/session";
import { DigestShare } from "@/components/digest/digest-share";
import { DigestView } from "@/components/digest/digest-view";
import { GenerateDigestButton } from "@/components/digest/generate-button";
import { EmptyState } from "@/components/ds/empty-state";
import { Eyebrow } from "@/components/ds/eyebrow";
import { Delta } from "@/components/ds/metric";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { describeDigest, loadDigestBundle } from "@/digest/page-data";
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

  const { activeLocation, digests, latest } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const active = resolveActiveLocation(await listLocationsForActor(tx, actor), cookieValue);
      const rows = active ? await listDigests(tx, actor.organizationId, active.id) : [];

      /*
        The newest week that can actually be read, loaded in full.

        `listDigests` is newest-first, so this is a `find` rather than a sort —
        and deliberately the newest **ready** one, not `rows[0]`: a week still
        composing or one that failed has no briefing behind it. When the newest
        is still composing, the last finished one leads, which is the honest
        answer to "what is my plan".

        Inside the same transaction as the list, through the shared loader, so
        this costs one client rather than opening a second `withTenant` — and so
        it cannot disagree with `/weekly-plan/{id}` about what a briefing is.
      */
      const newest = rows.find((row) => row.status === "ready");

      return {
        activeLocation: active,
        digests: rows,
        latest: newest ? await loadDigestBundle(tx, actor.organizationId, newest.id) : null,
      };
    },
  );

  if (!activeLocation) {
    return (
      <>
        <PageHeader title={t("archiveTitle")} />
        <Card>
          <EmptyState
            icon={MapPin}
            title={t("noLocation")}
            action={
              <Button asChild size="sm">
                <Link href="/locations">{t("noLocationAction")}</Link>
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  const described =
    latest?.digest && latest.digest.status === "ready"
      ? describeDigest({
          digest: latest.digest,
          locationName: latest.locationName,
          t,
          formatDate: (value, options) => format.dateTime(value, options),
          formatNumber: (value, maximumFractionDigits) =>
            format.number(value, { maximumFractionDigits }),
        })
      : null;

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
        // No action: the compose button is already in the page header two rows
        // up, and a second one here would be the same control twice.
        <Card>
          <EmptyState icon={CalendarRange} title={t("empty")} />
        </Card>
      ) : (
        <>
          {/*
            **The plan itself, not a link to it.**

            This screen is called "Your weekly plan" and showed four identical
            rows of dates — the product's headline feature presented as a filing
            cabinet, with the actual briefing two clicks from the rail. It led
            with a summary *card* for one commit, because rendering the briefing
            meant a second copy of `/weekly-plan/{id}`'s loader and two things to
            keep in step. `src/digest/page-data.ts` removed that trade: both
            surfaces now read through `loadDigestBundle` and `describeDigest`, so
            there is one definition of what a briefing is and this can simply be
            the thing.

            Only when it is `ready`. A week still composing or one that failed
            has nothing to render, and the archive below still lists it with its
            status — which is where "why is there no plan this week" is answered.

            `DigestShare` sits with it rather than in the page header: the header
            already carries "Compose this week", and two AI-ish controls side by
            side, one of which spends money, is the pairing to avoid.
          */}
          {latest?.digest && described ? (
            <section className="flex flex-col gap-(--grid-gap)">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <Eyebrow>{t("latestEyebrow")}</Eyebrow>
                  <p className="mt-1.5 text-display">{described.period}</p>
                </div>
                <DigestShare digestId={latest.digest.id} shareText={described.shareText} />
              </div>

              <DigestView digest={latest.digest} record={latest.record} />
            </section>
          ) : null}

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
        </>
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
