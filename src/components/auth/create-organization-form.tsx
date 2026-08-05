"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { organization } from "@/auth/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent } from "@/components/ui/card";
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
  const { toast } = useToast();
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);

    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    // Suffixed so two businesses with the same name do not collide on the
    // unique slug.
    const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;

    const created = await organization.create({ name, slug });

    if (created.error) {
      setPending(false);
      toast("error", created.error.message ?? tErrors("generic"));
      return;
    }

    // The shell reads the active organization from the session, so it has to be
    // set before navigating.
    const activated = await organization.setActive({ organizationId: created.data.id });
    setPending(false);

    if (activated.error) {
      toast("error", activated.error.message ?? tErrors("generic"));
      return;
    }

    router.push("/home");
    router.refresh();
  }

  return (
    <Card>
      {/* A real `<h1>` at the display size. `CardTitle` renders a `<div>` at
          the 14px card-title role, which is right for a widget inside a
          dashboard and wrong here: this is the only heading on the page, and it
          was coming out the same size as the field labels under it — with no
          heading element for a screen reader to find. */}
      <div className="px-(--card-px)">
        <h1 className="text-display text-balance">{t("createOrgTitle")}</h1>
        <p className="mt-1 text-body text-pretty text-ink-400">{t("createOrgSubtitle")}</p>
      </div>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t("orgName")}</Label>
            <Input id="name" name="name" required autoComplete="organization" />
          </div>

          <Button type="submit" className="w-full" disabled={pending}>
            {t("createOrg")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
