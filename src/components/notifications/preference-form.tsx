"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  clearNotificationPreferenceAction,
  saveNotificationPreferenceAction,
} from "@/server/notifications";

/**
 * One row of notification settings — the organization-wide default, or one
 * location's override (P1a-T5).
 *
 * Saving is explicit rather than on-change. These settings decide whether
 * someone's phone buzzes at 2am, and a toggle that commits as you drag past it
 * is the wrong interaction for that.
 *
 * Native `<select>`, matching the campaign form: the project has no select
 * primitive, and the native control is accessible and keyboard-complete.
 */

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export type PreferenceValue = {
  scope: "all" | "negative_only" | "off";
  delivery: "instant" | "digest";
  inApp: boolean;
  email: boolean;
};

export type PreferenceFormProps = {
  /** Null for the organization-wide default row. */
  locationId: string | null;
  locationName: string;
  value: PreferenceValue;
  /** True when this location has its own row rather than inheriting. */
  overridden: boolean;
};

export function PreferenceForm({
  locationId,
  locationName,
  value,
  overridden,
}: PreferenceFormProps) {
  const t = useTranslations("settings.notifications");
  const [draft, setDraft] = useState<PreferenceValue>(value);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const update = <K extends keyof PreferenceValue>(key: K, next: PreferenceValue[K]) => {
    setDraft((current) => ({ ...current, [key]: next }));
    setSaved(false);
  };

  const fieldId = locationId ?? "default";
  // "Nothing" makes every other control on the row meaningless; disabling them
  // says so, rather than letting someone tune settings that cannot apply.
  const disabled = draft.scope === "off";

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{locationName}</span>
        {overridden ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {t("overridden")}
          </span>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`scope-${fieldId}`}>{t("scope")}</Label>
          <select
            id={`scope-${fieldId}`}
            className={SELECT_CLASS}
            value={draft.scope}
            onChange={(event) => update("scope", event.target.value as PreferenceValue["scope"])}
          >
            <option value="all">{t("scopeAll")}</option>
            <option value="negative_only">{t("scopeNegative")}</option>
            <option value="off">{t("scopeOff")}</option>
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={`delivery-${fieldId}`}>{t("delivery")}</Label>
          <select
            id={`delivery-${fieldId}`}
            className={SELECT_CLASS}
            value={draft.delivery}
            disabled={disabled}
            onChange={(event) =>
              update("delivery", event.target.value as PreferenceValue["delivery"])
            }
          >
            <option value="instant">{t("deliveryInstant")}</option>
            <option value="digest">{t("deliveryDigest")}</option>
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={draft.inApp}
            disabled={disabled}
            onChange={(event) => update("inApp", event.target.checked)}
          />
          {t("inApp")}
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={draft.email}
            disabled={disabled}
            onChange={(event) => update("email", event.target.checked)}
          />
          {t("email")}
        </label>

        <div className="ml-auto flex items-center gap-2">
          {saved ? <span className="text-xs text-muted-foreground">{t("saved")}</span> : null}

          {locationId && overridden ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                startTransition(async () => {
                  await clearNotificationPreferenceAction({ locationId });
                  setSaved(false);
                });
              }}
            >
              {t("reset")}
            </Button>
          ) : null}

          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                const result = await saveNotificationPreferenceAction({ locationId, ...draft });
                setSaved(result.ok);
              });
            }}
          >
            {t("save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
