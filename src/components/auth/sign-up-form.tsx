"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { signUp } from "@/auth/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignUpForm() {
  const t = useTranslations("auth");
  const { toast } = useToast();
  const tErrors = useTranslations("errors");
  const router = useRouter();
  /**
   * Where to go afterwards, when something sent us here (W1.9).
   *
   * An invitation link bounces an unauthenticated visitor to sign-in; without
   * this they land on Home and the invitation is lost, which is the one moment
   * where the product must not forget what somebody was trying to do.
   *
   * **Only a path is honoured.** A full URL here would be an open redirect —
   * `?next=https://evil.test` on a page that has just taken a password.
   */
  const search = useSearchParams();
  const next = search.get("next");
  const destination = next?.startsWith("/") && !next.startsWith("//") ? next : null;

  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);

    const form = new FormData(event.currentTarget);
    const result = await signUp.email({
      name: String(form.get("name") ?? ""),
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });

    setPending(false);

    if (result.error) {
      // Surface the server's message when there is one — a rejected password
      // length is actionable, unlike a failed sign-in.
      toast("error", result.error.message ?? tErrors("signUpFailed"));
      return;
    }

    // A brand-new account has no organization yet.
    router.push(destination ?? "/create-organization");
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
        <h1 className="text-display text-balance">{t("signUpTitle")}</h1>
        <p className="mt-1 text-body text-pretty text-ink-400">{t("signUpSubtitle")}</p>
      </div>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t("name")}</Label>
            <Input id="name" name="name" required autoComplete="name" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">{t("email")}</Label>
            <Input id="email" name="email" type="email" required autoComplete="email" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">{t("password")}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
            />
            <p className="text-copy text-muted-foreground">{t("passwordHint")}</p>
          </div>

          <Button type="submit" className="w-full" disabled={pending}>
            {t("signUp")}
          </Button>
        </form>

        <p className="mt-4 text-center text-body text-muted-foreground">
          {t("haveAccount")}{" "}
          <Link
            // Carry the destination across, or an invited person who clicks
            // through to create an account loses the invitation (W1.9).
            href={destination ? `/sign-in?next=${encodeURIComponent(destination)}` : "/sign-in"}
            className="font-medium text-primary hover:underline"
          >
            {t("signIn")}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
