"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { useCreateSheet } from "@/components/ds/create-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VERTICALS } from "@/reviews/taxonomy";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { useAction } from "@/components/ui/use-action";
import { createLocationAction } from "@/server/locations";

/**
 * The fields, and nothing else (W1.7).
 *
 * It used to carry its own `Card`, heading and description, and a
 * `disabled`/`disabledReason` pair for a spent plan limit. All four belonged to
 * the *screen* rather than to the form: the panel supplies the heading, and a
 * limit that has been reached is now a sentence on the empty state instead of a
 * greyed-out button that explains nothing.
 *
 * One column rather than three: it lives in a side panel now, and a three-up
 * grid in a 32rem sheet is three cramped columns.
 */
export function AddLocationForm() {
  const t = useTranslations("locations");
  const tf = useTranslations("feedback");
  const { close } = useCreateSheet();
  const { run, pending, fieldErrors, formRef, invalid } = useAction();

  return (
    <form
      ref={formRef}
      action={(formData) =>
        run(() => createLocationAction(formData), {
          success: tf("created"),
          onSuccess: () => {
            formRef.current?.reset();
            close();
          },
        })
      }
      className="grid gap-4"
    >
      <div className="space-y-2">
        <Label htmlFor="name">{t("name")}</Label>
        <Input
          id="name"
          name="name"
          aria-required
          placeholder={t("namePlaceholder")}
          {...invalid("name")}
        />
        <FieldError name="name" message={fieldErrors.name} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="address">{t("address")}</Label>
        <Input
          id="address"
          name="address"
          placeholder={t("addressPlaceholder")}
          {...invalid("address")}
        />
        <FieldError name="address" message={fieldErrors.address} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="category">{t("category")}</Label>
        {/*
          A select, not a free-text box (W3.2). What somebody typed here used to
          be decoration; it now picks which canonical themes the model is
          offered for this branch's reviews, so "kafe", "Cafe" and "coffee shop"
          being three different answers meant three different vocabularies for
          the same kind of business.

          A native `<select>` rather than the Radix one: this sits inside a
          plain `<form>` that posts `FormData`, and the composite control does
          not submit a value without a hidden input shadowing it — one more
          thing to keep in step for a field with seven options.
        */}
        <select
          id="category"
          name="category"
          defaultValue=""
          className={cn(
            "h-9 w-full rounded-md border border-line bg-card px-3 text-body",
            "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          )}
          {...invalid("category")}
        >
          {/* Empty is a real answer: a business that has not said what it is
              gets the universal themes, which is most of what matters. */}
          <option value="">{t("categoryUnset")}</option>
          {VERTICALS.map((vertical) => (
            <option key={vertical} value={vertical}>
              {t(`vertical.${vertical}`)}
            </option>
          ))}
        </select>
        <FieldError name="category" message={fieldErrors.category} />
      </div>

      <Button type="submit" disabled={pending} className="w-fit">
        <Plus className="size-4" aria-hidden />
        {pending ? t("adding") : t("add")}
      </Button>
    </form>
  );
}
