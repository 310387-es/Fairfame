"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { useCreateSheet } from "@/components/ds/create-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
          required
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
        <Input
          id="category"
          name="category"
          placeholder={t("categoryPlaceholder")}
          {...invalid("category")}
        />
        <FieldError name="category" message={fieldErrors.category} />
      </div>

      <Button type="submit" disabled={pending} className="w-fit">
        <Plus className="size-4" aria-hidden />
        {pending ? t("adding") : t("add")}
      </Button>
    </form>
  );
}
