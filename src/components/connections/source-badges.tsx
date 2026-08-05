import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import type { SyncKind } from "@/connectors/capability-view";

/**
 * What state a source is in — **one** chip, not a pile of them (W1.4).
 *
 * **What this replaces.** Every connected source used to carry up to four
 * badges at once, and the commonest pair was a contradiction: *Live sync* beside
 * *Sample data*. Both were true statements about different things — the
 * provider's declared capability, and the fact that a fixture was serving it —
 * and together they said nothing a reader could act on. A design partner
 * looking at that row cannot tell whether they are seeing their own reviews.
 *
 * So the badges collapse into one answer to the question somebody actually has:
 * *is this working?*
 *
 *   - **Needs attention** — the last sync failed. Outranks everything, because
 *     a broken connection is the only state that needs a person today.
 *   - **Finish setup** — authorized but not yet pointed at a place on the
 *     platform. Kept apart from "needs attention" because it names the next
 *     step rather than a fault.
 *   - **Demo data** — a fixture is serving this. Outranks "connected": calling
 *     seeded data a connection is the exact lie the old pair told.
 *   - **Connected** — none of the above.
 *
 * `Monitor only` survives as a second chip, and it is not a status: it is a
 * permanent property of a source we can only read excerpts from, true before
 * and after go-live. Dropping it would over-promise. `Live sync` is gone
 * entirely — it was the badge doing the lying, and "Connected" says the same
 * thing without claiming anything about where the data came from.
 */

export type SourceBadgesProps = {
  sync: SyncKind;
  isMock: boolean;
  status?: "pending" | "active" | "error" | "disconnected";
};

/** The one state chip, in priority order. */
function stateOf({
  isMock,
  status,
}: Pick<SourceBadgesProps, "isMock" | "status">): "error" | "pending" | "demo" | "connected" {
  if (status === "error" || status === "disconnected") return "error";
  if (status === "pending") return "pending";
  if (isMock) return "demo";
  return "connected";
}

export function SourceBadges({ sync, isMock, status }: SourceBadgesProps) {
  const t = useTranslations("sources");

  const state = stateOf({ isMock, status });

  const chip = {
    error: { label: t("needsAttention"), variant: "destructive" as const },
    pending: { label: t("finishSetup"), variant: "outline" as const },
    demo: { label: t("demoData"), variant: "secondary" as const },
    connected: { label: t("connected"), variant: "positive" as const },
  }[state];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant={chip.variant}>{chip.label}</Badge>
      {/* Not a status — a limit of the source itself, true whatever state it is
          in. Only shown when it is actually true. */}
      {sync === "monitor" ? <Badge variant="outline">{t("monitorOnly")}</Badge> : null}
    </div>
  );
}
