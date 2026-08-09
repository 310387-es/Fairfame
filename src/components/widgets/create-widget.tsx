"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldError } from "@/components/ui/field-error";
import { useAction } from "@/components/ui/use-action";
import { createWidgetAction } from "@/server/widgets";

/**
 * Create a widget: a name, and which branch it speaks for.
 *
 * Only two fields, because everything else is easier to decide while looking at
 * a preview. Creating drops you straight into the builder rather than back onto
 * a list — a widget with no configuration is not a thing anyone wanted to make,
 * it is step one of making one.
 */
export function CreateWidget({ locations }: { locations: { id: string; name: string }[] }) {
  const t = useTranslations("widgets");
  const router = useRouter();
  // "all" rather than "": Radix reads the empty string as "nothing selected"
  // and would show a placeholder where a real, deliberate choice belongs.
  const [locationId, setLocationId] = useState("all");
  const { run, pending, fieldErrors, formRef, invalid } = useAction();

  return (
    <form
      className="grid gap-4"
      ref={formRef}
      action={(formData) =>
        run(
          () =>
            createWidgetAction({
              name: String(formData.get("name") ?? ""),
              locationId: locationId === "all" ? "" : locationId,
            }),
          {
            // No toast on success: the next thing that happens is the
            // builder opening, which is a louder confirmation than a word.
            onSuccess: (result) => {
              if (result?.id) router.push(`/widgets/${result.id}`);
            },
          },
        )
      }
    >
      <div className="space-y-2">
        <Label htmlFor="widget-name">{t("nameLabel")}</Label>
        <Input
          id="widget-name"
          name="name"
          aria-required
          maxLength={80}
          placeholder={t("namePlaceholder")}
          {...invalid("name")}
        />
        <FieldError name="name" message={fieldErrors.name} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="widget-location">{t("locationLabel")}</Label>
        <Select value={locationId} onValueChange={setLocationId}>
          <SelectTrigger id="widget-location">
            <SelectValue placeholder={t("allLocations")} />
          </SelectTrigger>
          <SelectContent>
            {/* Radix treats "" as "no selection", so the org-wide choice needs
                  a real value; it is mapped back to null on the server. */}
            <SelectItem value="all">{t("allLocations")}</SelectItem>
            {locations.map((location) => (
              <SelectItem key={location.id} value={location.id}>
                {location.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? t("creating") : t("create")}
      </Button>
    </form>
  );
}
