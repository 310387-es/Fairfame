"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SectionCard } from "@/components/ds/section-card";
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
import { createWidgetAction } from "@/server/widgets";

/**
 * Create a widget: a name, and which branch it speaks for.
 *
 * Only two fields, because everything else is easier to decide while looking at
 * a preview. Creating drops you straight into the builder rather than back onto
 * a list — a widget with no configuration is not a thing anyone wanted to make,
 * it is step one of making one.
 */
export function CreateWidget({
  locations,
  atLimit,
}: {
  locations: { id: string; name: string }[];
  atLimit: boolean;
}) {
  const t = useTranslations("widgets");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // "all" rather than "": Radix reads the empty string as "nothing selected"
  // and would show a placeholder where a real, deliberate choice belongs.
  const [locationId, setLocationId] = useState("all");
  const [pending, startTransition] = useTransition();

  return (
    <SectionCard title={t("createTitle")} icon={Plus} tone="accent">
      {/*
        Fields in a row, the button on its own line — the same shape
        `add-location-form.tsx` uses, and not merely for consistency.

        The button was in a third column with `items-end`, and the two fields
        did not line up. Radix's `Select` renders a hidden native `<select>`
        after the trigger for form integration, which makes that column 8px
        taller than the plain `<Input>` beside it; bottom-aligning the columns
        then floated the trigger 8px above the input, and the labels with it.
        Aligning from the top instead means both columns are label + gap +
        control from the same origin, and the phantom trailing element is
        harmless.
      */}
      <form
        className="grid gap-4 pb-(--card-py) sm:grid-cols-2"
        action={(formData) => {
          setError(null);
          startTransition(async () => {
            const result = await createWidgetAction({
              name: String(formData.get("name") ?? ""),
              locationId: locationId === "all" ? "" : locationId,
            });

            if (result.ok && result.id) router.push(`/widgets/${result.id}`);
            else if (!result.ok) setError(result.error);
          });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="widget-name">{t("nameLabel")}</Label>
          <Input
            id="widget-name"
            name="name"
            required
            maxLength={80}
            placeholder={t("namePlaceholder")}
          />
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

        <div className="sm:col-span-2">
          {atLimit ? <p className="mb-3 text-body text-ink-400">{t("atLimit")}</p> : null}
          {error ? (
            <p role="alert" className="mb-3 text-body text-destructive">
              {error}
            </p>
          ) : null}

          <Button type="submit" disabled={pending || atLimit}>
            {pending ? t("creating") : t("create")}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
