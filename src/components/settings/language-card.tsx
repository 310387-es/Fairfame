"use client";

import { Languages } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAction } from "@/components/ui/use-action";
import { LOCALES, type Locale } from "@/i18n/config";
import { setLocaleAction } from "@/app/actions";

/**
 * Language, in Settings (W3.3).
 *
 * The top-bar toggle has always existed and is staying — it is two letters and
 * one click, which is right for something people flip while showing the product
 * to somebody. What it never did was *explain itself*, and that is what belongs
 * on a settings page: this control says the choice is stored against **you**,
 * not the browser, and that it now follows you to another device.
 *
 * Both write through `setLocaleAction`, so there is one path that sets a
 * language and one place the precedence is decided. Two controls that both
 * looked authoritative and disagreed would be worse than the single toggle.
 *
 * ## Timezone and currency are deliberately absent
 *
 * `docs/remediation-plan.md` folds "locale/timezone/currency" into this. Only
 * locale is added, because only locale is *read*:
 *
 *   - **Timezone** — nothing stores one, and every timestamp on screen is
 *     formatted by `next-intl` against the reader's own browser, which is
 *     already right for a person and wrong only for the digest and the
 *     scheduled report. Those need a timezone to decide *when a week ends*,
 *     which is a change to `src/reports/period.ts` and the sweeps, not a
 *     select. A stored field nothing consults is the `competitor_snapshots`
 *     mistake this codebase has named twice.
 *   - **Currency** — `organizations.currency` already exists and is already set
 *     from the plan a business buys (`canCheckout` reads it). Offering it as a
 *     free choice would let somebody put their account into a currency Stripe
 *     is not configured for, which is a billing failure rather than a
 *     preference.
 */
export function LanguageCard({ current }: { current: Locale }) {
  const t = useTranslations("settings.language");
  const { run, pending } = useAction();
  const [value, setValue] = useState<Locale>(current);

  const change = (next: string) => {
    const locale = next as Locale;
    setValue(locale);
    // No success toast: the entire page is about to re-render in the new
    // language, which is a louder confirmation than a message could be.
    void run(async () => {
      await setLocaleAction(locale);
      return { ok: true as const };
    });
  };

  return (
    <Card id="language" className="mt-4 scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Languages className="size-4 text-ink-400" aria-hidden />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("subtitle")}</CardDescription>
      </CardHeader>

      <CardContent>
        <label className="flex max-w-xs flex-col gap-1.5">
          <span className="text-meta text-faint">{t("label")}</span>
          <Select value={value} onValueChange={change} disabled={pending}>
            <SelectTrigger aria-label={t("label")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCALES.map((locale) => (
                <SelectItem key={locale} value={locale}>
                  {t(`option.${locale}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </CardContent>
    </Card>
  );
}
