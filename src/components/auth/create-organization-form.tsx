"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { organization } from "@/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Turns a display name into a URL-safe slug, Turkish characters included. */
function slugify(value: string): string {
  const TR: Record<string, string> = {
    ç: "c",
    ğ: "g",
    ı: "i",
    ö: "o",
    ş: "s",
    ü: "u",
    İ: "i",
  };

  return value
    .toLowerCase()
    .replace(/[çğıöşüİ]/g, (char) => TR[char] ?? char)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function CreateOrganizationForm() {
  const t = useTranslations("auth");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    // Suffixed so two businesses with the same name do not collide on the
    // unique slug.
    const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;

    const created = await organization.create({ name, slug });

    if (created.error) {
      setPending(false);
      setError(created.error.message ?? tErrors("generic"));
      return;
    }

    // The shell reads the active organization from the session, so it has to be
    // set before navigating.
    const activated = await organization.setActive({ organizationId: created.data.id });
    setPending(false);

    if (activated.error) {
      setError(activated.error.message ?? tErrors("generic"));
      return;
    }

    router.push("/home");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("createOrgTitle")}</CardTitle>
        <CardDescription>{t("createOrgSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t("orgName")}</Label>
            <Input id="name" name="name" required autoComplete="organization" />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={pending}>
            {t("createOrg")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
