"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { signUp } from "@/auth/client";
import { safeNextPath } from "@/auth/next-path";
import { AuthDivider } from "@/components/auth/auth-divider";
import { AuthLegalLine } from "@/components/auth/auth-legal-line";
import { GoogleButton } from "@/components/auth/google-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignUpForm({ googleEnabled }: { googleEnabled: boolean }) {
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
   * **Only a path is honoured** — see `safeNextPath`, which is shared with the
   * guard that bounces an already-signed-in visitor off this page, so the two
   * cannot disagree about what an acceptable destination is.
   */
  const search = useSearchParams();
  const destination = safeNextPath(search.get("next"));

  const [pending, setPending] = useState(false);

  /**
   * The marketing tick, held in React rather than read off the form (P5-T2).
   *
   * Radix renders a button with a hidden input behind it, and `signUp.email`
   * takes an object rather than a `FormData` — so the value has to be a
   * variable at the moment of the call either way. Starting at `false` is the
   * requirement, not a default: an unticked box is the only honest starting
   * state for an optional permission, and it is what makes this consent rather
   * than a pre-selected assumption somebody failed to notice.
   */
  const [marketingConsent, setMarketingConsent] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);

    const form = new FormData(event.currentTarget);
    const result = await signUp.email({
      name: String(form.get("name") ?? ""),
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      // Declared as a BetterAuth additional field, so it is persisted with the
      // user row rather than written afterwards by a second call that could
      // fail on its own. The *timestamp* beside it is stamped server-side —
      // see the create hook in `src/auth/config.ts`.
      marketingEmailConsent: marketingConsent,
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
        {/*
          What the trial actually is, in the one line under the title.

          It replaced "Start your 14-day trial. No card required." rather than
          joining it: a second sentence under the button saying almost the same
          thing put two nearly-identical grey lines on one card, and a reader
          scanning them assumes the repetition is hiding a difference. Every
          clause here is checkable — `TRIAL_DAYS` is 14,
          `provisionTrialSubscription` grants the top tier, and no payment
          method is collected anywhere in this flow — and it is written flat on
          purpose. A superlative would be the one unverifiable sentence on a
          screen whose whole job is to be trusted.
        */}
        <p className="mt-1 text-body text-pretty text-ink-400">{t("signUpSubtitle")}</p>
      </div>
      <CardContent>
        {/*
          Google first, and the fields as the alternative (P5-T1).

          The customer this product is for owns a Google account by definition
          — Business Profile is the anchor source — so the one-tap route is the
          ordinary one and the twelve-character password is the fallback. It
          renders only where a client is configured; see `isGoogleAuthConfigured`.
        */}
        {googleEnabled ? (
          <div className="mb-4 space-y-4">
            <GoogleButton destination={destination} />
            <AuthDivider />
          </div>
        ) : null}

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

          {/*
            The optional one, and the only checkbox on the screen (P5-T2).

            Unticked, and separate from the terms line below the button, because
            they are two different kinds of thing: accepting the terms is a
            condition of having an account, and this is a permission that can be
            declined with no consequence at all. Bundling them — one box for
            both — is the pattern that makes a marketing list unlawful, since
            nobody can tell which half was agreed to.

            Nothing sends against it yet. The record exists before the first
            send does, which is the same ordering as the İYS gate.
          */}
          <div className="flex items-start gap-2.5 pt-1">
            <Checkbox
              id="marketingEmailConsent"
              name="marketingEmailConsent"
              checked={marketingConsent}
              onCheckedChange={(value) => setMarketingConsent(value === true)}
              className="mt-0.5"
            />
            <Label
              htmlFor="marketingEmailConsent"
              className="text-copy leading-snug font-normal text-pretty text-ink-400"
            >
              {t("marketingConsent")}
            </Label>
          </div>

          <Button type="submit" className="w-full" disabled={pending}>
            {t("signUp")}
          </Button>
        </form>

        <AuthLegalLine />

        <p className="mt-4 text-center text-body text-ink-400">
          {t("haveAccount")}{" "}
          <Link
            // Carry the destination across, or an invited person who clicks
            // through to create an account loses the invitation (W1.9).
            href={destination ? `/sign-in?next=${encodeURIComponent(destination)}` : "/sign-in"}
            // The system's ring, not the browser's. `docs/15` §4 is "one ring
            // everywhere"; without these classes this link was the only
            // focusable thing on the page wearing Chrome's default outline,
            // beside a button and three fields that all carry `--focus-ring`.
            className="rounded-sm font-medium text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {t("signIn")}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
