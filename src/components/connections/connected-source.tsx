import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { GoLiveNote } from "@/components/connections/go-live-note";
import { HealthBadge } from "@/components/connections/health-badge";
import { ProviderMark } from "@/components/connections/provider-mark";
import { Sparkline } from "@/components/ds/sparkline";
import { Card } from "@/components/ui/card";
import { SPARKLINE_DAYS, type ConnectedSourceCard as Card_ } from "@/connections/facts";
import { needsAttention } from "@/connections/health";
import { cn } from "@/lib/utils";

/**
 * One connected source, with every branch it feeds inside it (W4.2).
 *
 * **The health line comes before the numbers.** A card is read top-down and the
 * question that brought somebody here is "is this working" — the thirty-day
 * volume is what they look at once the answer is yes. Putting the sparkline
 * first would be putting the interesting thing above the important one.
 *
 * **The branch list only itemises when it has to.** One branch, or every branch
 * healthy, and it is a sentence — "5 şube". As soon as one of them is unwell
 * the list appears with the unwell ones first, because at that point *which*
 * branch is the entire content of the card.
 */
export async function ConnectedSourceCard({
  card,
  canManage,
}: {
  card: Card_;
  canManage: boolean;
}) {
  const [t, format] = await Promise.all([getTranslations("connections"), getFormatter()]);

  const unwell = card.locations.filter((location) => needsAttention(location.health));
  const ordered = [...card.locations].sort(
    (left, right) => Number(needsAttention(right.health)) - Number(needsAttention(left.health)),
  );

  return (
    <Card className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-start gap-3">
        <ProviderMark provider={card.provider} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-copy font-semibold text-foreground">{card.label}</h3>
            <HealthBadge health={card.health} />
            {card.isMock ? (
              <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-meta text-ink-500">
                {t("demoData")}
              </span>
            ) : null}
          </div>

          <p className="mt-0.5 text-meta text-faint">
            {card.lastSyncedAt === null
              ? t("neverSynced")
              : t("lastSynced", {
                  when: format.relativeTime(new Date(card.lastSyncedAt)),
                })}
          </p>
        </div>
      </div>

      {/*
        The provider's own words, only where somebody can act on them. A
        `limited` connection is throttled and recovering, and printing Meta's
        429 prose under an amber chip would turn a self-resolving state into
        something that looks like it needs a person.
      */}
      {card.lastError !== null && needsAttention(card.health) ? (
        <p className="rounded-md bg-state-negative-bg px-3 py-2 text-meta text-state-negative-text">
          {card.lastError}
        </p>
      ) : null}

      {card.isMock ? <GoLiveNote provider={card.provider} fallback={card.goLiveNote} /> : null}

      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-meta text-faint">{t("volumeLabel", { days: SPARKLINE_DAYS })}</p>
          <p className="text-subtitle font-semibold text-foreground tabular-nums">
            {format.number(card.volumeTotal)}
          </p>
        </div>
        <Sparkline values={card.volume} />
      </div>

      <div className="mt-auto border-t border-line pt-3">
        {unwell.length === 0 ? (
          <p className="text-meta text-ink-500">
            {t("feedsBranches", { count: card.locations.length })}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {ordered.map((location) => (
              <li key={location.locationId} className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "min-w-0 truncate text-meta",
                    needsAttention(location.health) ? "text-foreground" : "text-ink-500",
                  )}
                >
                  {location.name}
                </span>
                <HealthBadge health={location.health} />
              </li>
            ))}
          </ul>
        )}

        {canManage ? (
          <Link
            href="/locations"
            className="mt-2 inline-block text-meta font-medium text-primary hover:underline"
          >
            {t("manageOnLocations")}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}
