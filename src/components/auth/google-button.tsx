"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { signIn } from "@/auth/client";
import { ProviderMark } from "@/components/connections/provider-mark";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

/**
 * "Continue with Google" (P5-T1).
 *
 * ## Why it is the first thing on the screen
 *
 * The target customer owns a Google account by definition — Google Business
 * Profile is the anchor source of the whole product, and a business without one
 * has no reviews for us to manage. So the ordinary path in is the one-tap path,
 * and the twelve-character password is the fallback rather than the front door.
 * Above the fields, visually primary, with the divider saying the fields are
 * the alternative.
 *
 * ## The mark
 *
 * `ProviderMark` — the product's one Google G, already used on the Connections
 * screen, already reasoned about in that file's docblock, and already the
 * single place Google's four brand hexes are allowed to appear. Drawing a
 * second G here would give the product two Google marks that can drift apart,
 * which is the failure the "one definition" rule exists to stop.
 *
 * **This is the piece to re-check at go-live.** Google's Sign-In branding
 * guidelines specify their own asset, wordmark and metrics for this button, and
 * a reconstruction is a judgement call rather than compliance. The button
 * follows the guidelines' *shape* — white surface, neutral border, the mark to
 * the left of "Continue with Google", never recoloured, never re-worded — and
 * `docs/13-go-live.md` is where the asset swap belongs if brand review asks for
 * one.
 *
 * ## The button is not a `Button`
 *
 * `ui/button`'s variants are the product's own — indigo primary, ink, the
 * amber `brief`. Google's guidelines constrain the surface, the border and the
 * mark's clear space, and none of those is a value in our palette. Rendering it
 * as a `<button>` with explicit classes keeps that constraint visible instead
 * of hiding it inside a variant somebody later restyles product-wide.
 */
export function GoogleButton({
  /** Where to land afterwards. Already sanitised by `safeNextPath`. */
  destination,
  className,
}: {
  destination: string | null;
  className?: string;
}) {
  const t = useTranslations("auth");
  const tErrors = useTranslations("errors");
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);

    /**
     * Two destinations, because a returning customer and a brand-new one need
     * different next screens (W1.9, extended here).
     *
     * `callbackURL` is where an existing account lands — the invitation they
     * followed, or the dashboard. `newUserCallbackURL` is where an account that
     * did not exist a second ago lands, and a brand-new account has no
     * organization, so that is `/create-organization` exactly as the password
     * path does it.
     *
     * The invitation wins over both when there is one: somebody who clicked
     * "join this team" and signed up with Google must arrive at the invitation,
     * or the thing they were trying to do is silently lost. That is BetterAuth's
     * own redirect mechanics carrying our `next`, rather than a second scheme
     * running beside it.
     */
    const { error } = await signIn.social({
      provider: "google",
      callbackURL: destination ?? "/dashboard",
      newUserCallbackURL: destination ?? "/create-organization",
      errorCallbackURL: "/sign-in",
    });

    // A successful call navigates away, so this only runs on failure — but the
    // flag is cleared regardless, or a returning visitor pressing Back finds a
    // permanently disabled button.
    setPending(false);
    if (error) toast("error", error.message ?? tErrors("googleSignInFailed"));
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className={cn(
        // Google's guidelines: white surface, neutral hairline, the mark left
        // of the label. The radius and the height are ours — a control is 9px
        // and 32px in this system, and matching the fields below it is what
        // makes the pair read as one form rather than two designs.
        "flex h-9 w-full items-center justify-center gap-2.5 rounded-md border border-line bg-card text-title text-foreground transition-colors",
        "hover:bg-surface-hover focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
    >
      <ProviderMark provider="google" size={18} />
      {t("continueWithGoogle")}
    </button>
  );
}
