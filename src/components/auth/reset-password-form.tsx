"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { resetPassword } from "@/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";

/**
 * Setting a new password (W1.9b).
 *
 * The token arrives in the query, put there by BetterAuth's own
 * `/reset-password/:token` endpoint after it has checked the link — so this
 * screen never validates it and never needs to. It hands it back on submit, and
 * an expired or already-used one comes back as a failure.
 *
 * **Two fields, checked here.** Confirming a password is the one piece of
 * client-side validation worth doing at the client: the server cannot tell a
 * typo from an intention, and somebody who mistypes a password they cannot see
 * has locked themselves out of the account they were in the middle of
 * recovering. The length rule is the server's — `minPasswordLength: 12` — and
 * is stated rather than re-implemented.
 */

/** Mirrors `emailAndPassword.minPasswordLength` in `src/auth/config.ts`. */
const MIN_PASSWORD = 12;

export function ResetPasswordForm() {
  const t = useTranslations("auth");
  const tErrors = useTranslations("errors");
  const { toast } = useToast();
  const router = useRouter();
  const search = useSearchParams();

  const token = search.get("token");
  const [pending, setPending] = useState(false);
  const [mismatch, setMismatch] = useState(false);

  // No token means the link was mangled, or somebody typed the address in.
  // BetterAuth also redirects here with `?error=INVALID_TOKEN` for a dead link.
  if (!token || search.get("error")) {
    return (
      <Card>
        <div className="px-(--card-px)">
          <h1 className="text-display text-balance">{t("resetInvalidTitle")}</h1>
          <p className="mt-1 text-body text-pretty text-ink-400">{t("resetInvalidBody")}</p>
        </div>
        <CardContent>
          <Button asChild className="w-full">
            <Link href="/forgot-password">{t("forgotSubmit")}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");

    if (password !== String(form.get("confirm") ?? "")) {
      setMismatch(true);
      return;
    }

    setMismatch(false);
    setPending(true);

    const result = await resetPassword({ newPassword: password, token: token! });
    setPending(false);

    if (result.error) {
      // A dead token and a rejected password are different problems, and the
      // server's message says which — it is the only place that knows.
      toast("error", result.error.message ?? tErrors("generic"));
      return;
    }

    // To sign-in rather than straight into the app: resetting a password
    // deliberately does not create a session, so proving the new one works is
    // the next thing to do anyway.
    toast("success", t("resetDone"));
    router.push("/sign-in");
  }

  return (
    <Card>
      <div className="px-(--card-px)">
        <h1 className="text-display text-balance">{t("resetTitle")}</h1>
        <p className="mt-1 text-body text-pretty text-ink-400">{t("passwordHint")}</p>
      </div>

      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">{t("resetNew")}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              minLength={MIN_PASSWORD}
              autoComplete="new-password"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm">{t("resetConfirm")}</Label>
            <Input
              id="confirm"
              name="confirm"
              type="password"
              required
              minLength={MIN_PASSWORD}
              autoComplete="new-password"
              {...(mismatch ? { "aria-invalid": true, "aria-errormessage": "confirm-error" } : {})}
              onChange={() => setMismatch(false)}
            />
            {mismatch ? (
              <p id="confirm-error" className="text-copy text-state-negative-text">
                {t("resetMismatch")}
              </p>
            ) : null}
          </div>

          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? t("resetSaving") : t("resetSubmit")}
          </Button>

          {/* A way out, matching `forgot-password`. This screen had none: a
              person who followed the link, then remembered their password or
              changed their mind, had a form and no exit — and the only route
              back was the browser's Back button, which returns to a mail
              client. Every other pre-auth card offers this row. */}
          <p className="text-center text-body text-ink-400">
            <Link
              href="/sign-in"
              className="rounded-sm font-medium text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {t("backToSignIn")}
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
