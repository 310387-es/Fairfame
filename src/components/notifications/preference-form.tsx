"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/ui/use-action";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
 */

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
  const tf = useTranslations("feedback");
  const [draft, setDraft] = useState<PreferenceValue>(value);
  const [saved, setSaved] = useState(false);
  const { run, pending } = useAction();

  const update = <K extends keyof PreferenceValue>(key: K, next: PreferenceValue[K]) => {
    setDraft((current) => ({ ...current, [key]: next }));
    setSaved(false);
  };

  const fieldId = locationId ?? "default";
  // "Nothing" makes every other control on the row meaningless; disabling them
  // says so, rather than letting someone tune settings that cannot apply.
  const disabled = draft.scope === "off";

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-copy font-semibold">{locationName}</span>
        {overridden ? <Badge variant="secondary">{t("overridden")}</Badge> : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`scope-${fieldId}`}>{t("scope")}</Label>
          <Select
            value={draft.scope}
            onValueChange={(next) => update("scope", next as PreferenceValue["scope"])}
          >
            <SelectTrigger id={`scope-${fieldId}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("scopeAll")}</SelectItem>
              <SelectItem value="negative_only">{t("scopeNegative")}</SelectItem>
              <SelectItem value="off">{t("scopeOff")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={`delivery-${fieldId}`}>{t("delivery")}</Label>
          <Select
            value={draft.delivery}
            disabled={disabled}
            onValueChange={(next) => update("delivery", next as PreferenceValue["delivery"])}
          >
            <SelectTrigger id={`delivery-${fieldId}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="instant">{t("deliveryInstant")}</SelectItem>
              <SelectItem value="digest">{t("deliveryDigest")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {/* `htmlFor`, not a wrapping `<label>`: Radix renders a button, and a
            button inside a label is not a labelled control — clicking the text
            would do nothing. */}
        <div className="flex items-center gap-2">
          <Checkbox
            id={`in-app-${fieldId}`}
            checked={draft.inApp}
            disabled={disabled}
            onCheckedChange={(next) => update("inApp", next === true)}
          />
          <Label htmlFor={`in-app-${fieldId}`} className="text-copy">
            {t("inApp")}
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id={`email-${fieldId}`}
            checked={draft.email}
            disabled={disabled}
            onCheckedChange={(next) => update("email", next === true)}
          />
          <Label htmlFor={`email-${fieldId}`} className="text-copy">
            {t("email")}
          </Label>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {saved ? <span className="text-copy text-muted-foreground">{t("saved")}</span> : null}

          {locationId && overridden ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(() => clearNotificationPreferenceAction({ locationId }), {
                  success: tf("removed"),
                  onSuccess: () => setSaved(false),
                })
              }
            >
              {t("reset")}
            </Button>
          ) : null}

          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() =>
              run(() => saveNotificationPreferenceAction({ locationId, ...draft }), {
                success: tf("saved"),
                onSuccess: () => setSaved(true),
              })
            }
          >
            {t("save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
