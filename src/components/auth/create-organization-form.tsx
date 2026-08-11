"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { organization } from "@/auth/client";
import { createOrganizationAction } from "@/server/organizations";
import { useAction } from "@/components/ui/use-action";
import { FieldError } from "@/components/ui/field-error";
import { Button } from "@/components/ui/button";
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
  const tErrors = useTranslations("errors");
  const router = useRouter();
  // Reports through `useAction` like every other mutation (W1.5), which is also
  // what puts the plan's refusal on screen in the reader's language.
  const { run, pending, fieldErrors, formRef, invalid } = useAction();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    // Suffixed so two businesses with the same name do not collide on the
    // unique slug.
    const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;

    /**
     * Through the server, so the plan is consulted (11 Aug 2026).
     *
     * This was `organization.create` straight from the browser, which put the
     * entitlement layer nowhere on the path — and since every organization is
     * granted its own 14-day top-tier trial, unbounded creation was unbounded
     * trials. `createOrganizationAction` asks `organizationAllowance` first and
     * refuses with `entitlement:max_organizations`.
     */
    run(
      async () => {
        const created = await createOrganizationAction({ name, slug });
        if (!created.ok) return created;

        // The shell reads the active organization from the session, so it has
        // to be set before navigating. Client-side because it writes the
        // session cookie, which is the browser's.
        const activated = await organization.setActive({ organizationId: created.id! });
        if (activated.error) {
          return { ok: false as const, error: activated.error.message ?? tErrors("generic") };
        }

        return created;
      },
      {
        onSuccess: () => {
          router.push("/dashboard");
          router.refresh();
        },
        /**
         * The plan's refusal, in the reader's language.
         *
         * `message` exists for exactly this — the server writes
         * `EntitlementError` in English at the throw, where nobody knows who is
         * reading, and this is the first screen after signup, which is the
         * worst possible place to answer a Turkish café owner in English.
         *
         * Deliberately drops the server's counts rather than translating them:
         * a message needing `{limit}` and `{current}` would mean threading two
         * numbers through `ActionResult` for one sentence, and the exact
         * figures are on the plan screen this points at. Every other code keeps
         * the server's message, which stays the default.
         */
        message: (result) =>
          result.code === "entitlement:max_organizations" ? t("orgLimitReached") : undefined,
      },
    );
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
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t("orgName")}</Label>
            {/*
              `aria-required`, not `required` (A22-B3).

              This form reports through `useAction` now, and a native `required`
              blocks the submit *before* the action runs — so the whole
              reporting path never happens and the browser answers instead, in
              its own words and its own language. The promise to assistive
              technology is kept; the failure comes back through the one path
              every other failure uses, which puts a sentence under the field
              and moves focus to it.
            */}
            <Input
              id="name"
              name="name"
              aria-required
              autoComplete="organization"
              {...invalid("name")}
            />
            <FieldError name="name" message={fieldErrors.name} />
          </div>

          <Button type="submit" className="w-full" disabled={pending}>
            {t("createOrg")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
