"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createLocationAction } from "@/server/locations";

export function AddLocationForm({
  disabled,
  disabledReason,
}: {
  disabled?: boolean;
  disabledReason?: string;
}) {
  const t = useTranslations("locations");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("addTitle")}</CardTitle>
        <CardDescription>{t("addDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          ref={formRef}
          action={(formData) => {
            setError(null);
            startTransition(async () => {
              const result = await createLocationAction(formData);
              if (result.ok) {
                formRef.current?.reset();
              } else {
                setError(result.error);
              }
            });
          }}
          className="grid gap-4 sm:grid-cols-3"
        >
          <div className="space-y-2">
            <Label htmlFor="name">{t("name")}</Label>
            <Input id="name" name="name" required placeholder={t("namePlaceholder")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="address">{t("address")}</Label>
            <Input id="address" name="address" placeholder={t("addressPlaceholder")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="category">{t("category")}</Label>
            <Input id="category" name="category" placeholder={t("categoryPlaceholder")} />
          </div>

          <div className="sm:col-span-3">
            {error ? (
              <p role="alert" className="mb-3 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {disabled && disabledReason ? (
              <p className="mb-3 text-sm text-muted-foreground">{disabledReason}</p>
            ) : null}

            <Button type="submit" disabled={pending || disabled}>
              <Plus className="size-4" aria-hidden />
              {pending ? t("adding") : t("add")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
