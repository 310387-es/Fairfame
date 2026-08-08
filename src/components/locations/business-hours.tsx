"use client";

import { Clock, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useAction } from "@/components/ui/use-action";
import { setBusinessHoursAction } from "@/server/locations";

/**
 * When this branch is open (W5-8).
 *
 * Seven rows, Sunday first — the order `Date.getUTCDay()` uses, which is what
 * `opening-hours.ts` indexes by. A Monday-first strip would look more natural
 * to a Turkish reader and would put a second weekday convention one file away
 * from the lookup, which is how an off-by-one hides for a year. The *labels*
 * are localised; the order is not a display choice.
 *
 * The consequence is stated on the panel rather than left to be discovered:
 * this is the only setting whose effect is a change to numbers already on
 * another screen, and "your overdue count just dropped by nine" is a surprise
 * unless somebody was told it would.
 */

export type DayHoursValue = { open: string; close: string } | null;

/** Sunday-first, so the array index is `getUTCDay()`. */
const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const DEFAULT_DAY = { open: "09:00", close: "18:00" };

export function BusinessHours({
  locationId,
  value,
  canManage,
}: {
  locationId: string;
  value: DayHoursValue[] | null;
  canManage: boolean;
}) {
  const t = useTranslations("locations.hours");
  const { run, pending } = useAction();
  const [days, setDays] = useState<DayHoursValue[]>(() => value ?? DAY_KEYS.map(() => null));
  const [dirty, setDirty] = useState(false);

  const update = (index: number, next: DayHoursValue) => {
    setDays((current) => current.map((day, at) => (at === index ? next : day)));
    setDirty(true);
  };

  if (!canManage) {
    if (!value) return null;
    return (
      <div className="border-t border-line pt-4">
        <h3 className="text-title">{t("heading")}</h3>
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {value.map((day, index) => (
            <li key={DAY_KEYS[index]} className="text-copy text-muted-foreground">
              {t(`day.${DAY_KEYS[index]!}`)} · {day ? `${day.open}–${day.close}` : t("closed")}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-title">
          <Clock className="size-4 text-ink-400" aria-hidden />
          {t("heading")}
        </h3>
        <p className="text-copy text-muted-foreground">{t("description")}</p>
      </div>

      <ul className="flex flex-col gap-1.5">
        {DAY_KEYS.map((key, index) => {
          const day = days[index] ?? null;

          return (
            <li key={key} className="flex flex-wrap items-center gap-2.5">
              <Checkbox
                id={`open-${locationId}-${key}`}
                checked={day !== null}
                disabled={pending}
                onCheckedChange={(checked) =>
                  update(index, checked === true ? { ...DEFAULT_DAY } : null)
                }
              />
              <label htmlFor={`open-${locationId}-${key}`} className="w-24 shrink-0 text-body">
                {t(`day.${key}`)}
              </label>

              {day ? (
                <>
                  <Input
                    type="time"
                    aria-label={t("openAt", { day: t(`day.${key}`) })}
                    value={day.open}
                    disabled={pending}
                    className="w-28"
                    onChange={(event) => update(index, { ...day, open: event.target.value })}
                  />
                  <span aria-hidden className="text-muted-foreground">
                    –
                  </span>
                  <Input
                    type="time"
                    aria-label={t("closeAt", { day: t(`day.${key}`) })}
                    value={day.close}
                    disabled={pending}
                    className="w-28"
                    onChange={(event) => update(index, { ...day, close: event.target.value })}
                  />
                </>
              ) : (
                <span className="text-copy text-muted-foreground">{t("closed")}</span>
              )}
            </li>
          );
        })}
      </ul>

      {/* The effect, said before it happens. This is the only setting in the
          product that changes numbers on another screen. */}
      <p className="text-copy text-muted-foreground">{t("effect")}</p>

      <div>
        <Button
          type="button"
          size="sm"
          disabled={pending || !dirty}
          onClick={() =>
            run(() => setBusinessHoursAction({ locationId, hours: days }), {
              onSuccess: () => setDirty(false),
            })
          }
        >
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t("save")}
        </Button>
      </div>
    </div>
  );
}
