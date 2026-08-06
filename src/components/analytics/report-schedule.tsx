"use client";

import { Check, CalendarClock } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { SectionCard } from "@/components/ds/section-card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAction } from "@/components/ui/use-action";
import { setReportScheduleAction } from "@/server/reports";

/**
 * "Email me this as a PDF" (P3-T5).
 *
 * On Insights rather than in Settings, because the thing being scheduled is the
 * page you are looking at — and because the decision to want it weekly is made
 * while reading it, not while configuring an account.
 *
 * The copy says **who it goes to**, which is the one thing a scheduling control
 * usually leaves ambiguous: this one mails the person who set it, at their own
 * address, and there is no recipient field because there is nobody else to
 * choose until invitations exist.
 */
/** Radix cannot hold "" as a `SelectItem` value; this stands in for it. */
export const ALL_BRANCHES = "all";

export function ReportSchedule({
  enabled,
  cadence,
  locationId,
  locations,
  locked,
  bare = false,
}: {
  enabled: boolean;
  cadence: "weekly" | "monthly";
  /** The empty string is the explicit "every branch I can see" choice. */
  locationId: string;
  locations: { id: string; name: string }[];
  /** Non-null when the plan does not include reports — the reason, in words. */
  locked: string | null;
  /**
   * Render the controls alone, without the card around them (W4.4).
   *
   * The schedule moved out of the page and into a sheet opened from the header;
   * a `SectionCard` inside a sheet is a card inside a panel, which is one box
   * too many. The *form* is identical either way on purpose — one set of
   * controls, so the two placements cannot drift.
   */
  bare?: boolean;
}) {
  const t = useTranslations("insights");
  const tf = useTranslations("feedback");
  const [state, setState] = useState({ enabled, cadence, locationId });
  const [saved, setSaved] = useState(true);
  const { run, pending } = useAction();

  const patch = (next: Partial<typeof state>) => {
    setState((current) => ({ ...current, ...next }));
    setSaved(false);
  };

  const save = (override: Partial<typeof state> = {}) => {
    const next = { ...state, ...override };
    run(
      () =>
        setReportScheduleAction({
          ...next,
          // The sentinel becomes the empty string the action's schema reads as
          // "every branch". Radix will not hold an empty string as a value, so
          // the translation has to happen at exactly one edge — this one.
          locationId: next.locationId === ALL_BRANCHES ? "" : next.locationId,
        }),
      {
        success: tf("saved"),
        onSuccess: () => {
          setState(next);
          setSaved(true);
        },
      },
    );
  };

  if (locked) {
    return bare ? (
      <p className="text-body text-ink-400">{locked}</p>
    ) : (
      <SectionCard title={t("report.title")} icon={CalendarClock}>
        <p className="pb-(--card-py) text-body text-ink-400">{locked}</p>
      </SectionCard>
    );
  }

  const controls = (
    <div className="flex flex-col gap-4">
      <p className="text-body text-ink-400">{t("report.body")}</p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-meta text-faint">{t("report.cadenceLabel")}</span>
          <Select
            value={state.cadence}
            onValueChange={(value) => patch({ cadence: value as "weekly" | "monthly" })}
          >
            <SelectTrigger id="report-cadence" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">{t("report.weekly")}</SelectItem>
              <SelectItem value="monthly">{t("report.monthly")}</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-meta text-faint">{t("report.scopeLabel")}</span>
          <Select value={state.locationId} onValueChange={(value) => patch({ locationId: value })}>
            <SelectTrigger id="report-scope" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_BRANCHES}>{t("report.allBranches")}</SelectItem>
              {locations.map((location) => (
                <SelectItem key={location.id} value={location.id}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        {state.enabled ? (
          <>
            <Button type="button" onClick={() => save()} disabled={pending || saved}>
              {saved ? (
                <>
                  <Check className="size-4" aria-hidden />
                  {t("report.saved")}
                </>
              ) : (
                t(pending ? "report.saving" : "report.save")
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => save({ enabled: false })}
              disabled={pending}
            >
              {t("report.stop")}
            </Button>
          </>
        ) : (
          <Button type="button" onClick={() => save({ enabled: true })} disabled={pending}>
            {t(pending ? "report.saving" : "report.start")}
          </Button>
        )}
      </div>
    </div>
  );

  if (bare) return controls;

  return (
    <SectionCard
      title={t("report.title")}
      icon={CalendarClock}
      meta={state.enabled ? t("report.on") : t("report.off")}
    >
      <div className="pb-(--card-py)">{controls}</div>
    </SectionCard>
  );
}
