"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAction } from "@/components/ui/use-action";
import { saveBrandingAction } from "@/server/agency";

/**
 * Branding (P4-T5).
 *
 * Two halves, and the form says which is which rather than mixing them: a name,
 * a logo and a colour are for anybody, while removing Revira's mark and serving
 * from your own domain need `white_label`. Gating the first three would mean
 * charging Agency prices for having a logo.
 *
 * **The custom-domain field tells the truth about itself.** Storing a hostname
 * is not serving one — DNS and a certificate are infrastructure this
 * application cannot provision — so the hint says the domain must already point
 * here, rather than presenting a finished feature.
 */
export function BrandingForm({
  initial,
  canWhiteLabel,
}: {
  initial: {
    senderName: string;
    primaryColor: string;
    logoUrl: string;
    hidePoweredBy: boolean;
    customDomain: string;
  };
  canWhiteLabel: boolean;
}) {
  const t = useTranslations("branding");
  const tf = useTranslations("feedback");
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [saved, setSaved] = useState(false);
  const { run, pending } = useAction();

  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = () => {
    setSaved(false);

    run(
      () =>
        saveBrandingAction({
          senderName: values.senderName.trim() || null,
          primaryColor: values.primaryColor.trim() || null,
          logoUrl: values.logoUrl.trim() || null,
          hidePoweredBy: values.hidePoweredBy,
          customDomain: values.customDomain.trim() || null,
        }),
      {
        success: tf("saved"),
        onSuccess: () => {
          setSaved(true);
          router.refresh();
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4 pb-(--card-py)">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="brand-name">{t("senderName")}</Label>
          <Input
            id="brand-name"
            value={values.senderName}
            maxLength={80}
            onChange={(event) => set("senderName", event.target.value)}
          />
          <p className="text-meta text-faint">{t("senderNameHint")}</p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="brand-color">{t("primaryColor")}</Label>
          <Input
            id="brand-color"
            value={values.primaryColor}
            maxLength={7}
            placeholder="#3d5af1"
            onChange={(event) => set("primaryColor", event.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="brand-logo">{t("logoUrl")}</Label>
        <Input
          id="brand-logo"
          value={values.logoUrl}
          maxLength={500}
          placeholder="https://…"
          onChange={(event) => set("logoUrl", event.target.value)}
        />
      </div>

      {/* The two that need the entitlement, in their own block so the
          difference is visible rather than discovered on save. */}
      <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-sunken px-3 py-3">
        <p className="text-eyebrow text-faint uppercase">{t("agencyOnly")}</p>

        {!canWhiteLabel ? <p className="text-meta text-faint">{t("locked")}</p> : null}

        <div className="flex items-center gap-2">
          <Checkbox
            id="brand-hide"
            checked={values.hidePoweredBy}
            disabled={!canWhiteLabel}
            onCheckedChange={(next) => set("hidePoweredBy", next === true)}
          />
          <Label htmlFor="brand-hide">{t("hidePoweredBy")}</Label>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="brand-domain">{t("customDomain")}</Label>
          <Input
            id="brand-domain"
            value={values.customDomain}
            maxLength={200}
            disabled={!canWhiteLabel}
            placeholder="reviews.example.com"
            onChange={(event) => set("customDomain", event.target.value)}
          />
          {/* Says what it does and does not do. */}
          <p className="text-meta text-faint">{t("customDomainHint")}</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? t("saving") : t("save")}
        </Button>
        {saved ? (
          <span role="status" className="text-meta text-faint">
            {t("saved")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
