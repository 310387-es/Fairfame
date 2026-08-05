"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { requestPasswordReset } from "@/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";

/**
 * Asking for a way back in (W1.9b).
 *
 * **It says the same thing whatever happens.** Whether the address has an
 * account, has none, or the send itself failed, the reader is told the same
 * sentence — because any difference between those answers turns this form into
 * a way to find out who has an account here. BetterAuth is built the same way
 * (it does dummy work and returns an identical body for an unknown address), so
 * this screen is only holding up its end.
 *
 * That is also why the confirmation *replaces* the form rather than appearing
 * beside it: somebody who mistypes their address and sees "check your email"
 * should be told to try again explicitly, not left retrying into a form that
 * says the same thing every time.
 */
export function ForgotPasswordForm() {
  const t = useTranslations("auth");
  const { toast } = useToast();

  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);

    const email = String(new FormData(event.currentTarget).get("email") ?? "");

    // The result is deliberately not branched on. `requestPasswordReset`
    // answers the same way for an address with no account, and a UI that
    // distinguished them would undo that.
    await requestPasswordReset({ email, redirectTo: "/reset-password" });

    setPending(false);
    setSent(true);
  }

  return (
    <Card>
      <div className="px-(--card-px)">
        <h1 className="text-display text-balance">{t("forgotTitle")}</h1>
        <p className="mt-1 text-body text-pretty text-ink-400">
          {sent ? t("forgotSentBody") : t("forgotSubtitle")}
        </p>
      </div>

      <CardContent>
        {sent ? (
          <div className="flex flex-col gap-3">
            <Button
              variant="outline"
              onClick={() => {
                setSent(false);
                toast("success", t("forgotTryAgain"));
              }}
            >
              {t("forgotTryAgain")}
            </Button>
            <p className="text-center text-copy text-ink-400">
              <Link href="/sign-in" className="font-medium text-primary hover:underline">
                {t("backToSignIn")}
              </Link>
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t("email")}</Label>
              <Input id="email" name="email" type="email" required autoComplete="email" autoFocus />
            </div>

            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? t("forgotSending") : t("forgotSubmit")}
            </Button>

            <p className="text-center text-copy text-ink-400">
              <Link href="/sign-in" className="font-medium text-primary hover:underline">
                {t("backToSignIn")}
              </Link>
            </p>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
