"use client";

import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";

/**
 * The terms and the KVKK notice, read without leaving the form.
 *
 * ## Why a modal and not a page
 *
 * Both openers used to navigate, so a visitor half way through signing up who
 * wanted to check what they were agreeing to lost their name, their email and
 * their password — and arrived somewhere with no way back but the browser's
 * Back button. **A consent notice that punishes reading it is a consent notice
 * nobody reads**, which is the opposite of what putting it at the point of
 * collection was for.
 *
 * ## There is deliberately no standalone page
 *
 * `/legal/terms` and `/legal/kvkk` existed for one release and were removed on
 * 11 Aug 2026. The argument for keeping them was that a legal document wants an
 * address — linkable from an email footer, sendable to a lawyer, printable. The
 * decision went the other way: the notice is read at the point of collection or
 * not at all, and two surfaces for one document is two things to keep in step
 * for a reader nobody had yet.
 *
 * **The trade is real and worth knowing before undoing it.** There is now no URL
 * for this text, so nothing outside the auth screens can point at it. If an
 * email footer, a public pricing page or a customer request ever needs one, the
 * page comes back — and `LegalDocument` below is deliberately a separate
 * component from the dialog chrome so that bringing it back is a route file and
 * nothing else.
 *
 * The trigger is a `<button>`, not a link: it does not navigate, so announcing
 * it as a link would promise a destination it has no intention of visiting.
 */

const POINTS = {
  terms: ["service", "account", "trial", "data", "ending"],
  kvkk: ["controller", "collected", "purpose", "ground", "sharing", "rights"],
} as const;

export type LegalKind = keyof typeof POINTS;

/**
 * The document body.
 *
 * Kept apart from the dialog around it because it is the *content* and the
 * dialog is the *frame* — the two have different reasons to change, and this is
 * the half that would be reused if the notice is ever given a page again.
 *
 * The heading is not rendered here: it is the dialog's own title, which Radix
 * must own for the accessible name. Emitting one would mean either two headings
 * or a dialog announced as "dialog".
 */
function LegalDocument({ kind }: { kind: LegalKind }) {
  const t = useTranslations(`legal.${kind}`);

  return (
    <div>
      <p className="text-body text-pretty text-ink-400">{t("intro")}</p>

      <dl className="mt-6 space-y-5">
        {POINTS[kind].map((point) => (
          <div key={point}>
            <dt className="text-title">{t(`${point}.heading`)}</dt>
            <dd className="mt-1 text-body text-pretty text-ink-500">{t(`${point}.body`)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function LegalDialog({
  kind,
  /** The link text as it appears mid-sentence in the consent line. */
  label,
}: {
  kind: LegalKind;
  label: string;
}) {
  const t = useTranslations("legal");

  return (
    <Dialog>
      <DialogTrigger
        className={
          // Underlined so it still reads as "you can open this" inside a
          // sentence — the affordance is what the eye looks for, and it was a
          // link a moment ago.
          "rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        }
      >
        {label}
      </DialogTrigger>

      {/*
        The draft notice is the dialog's `description`, which puts it above the
        text and inside the accessible name Radix announces on open. A reader
        deciding whether to trust this should not have to reach the bottom to
        learn it is a draft pending legal review.
      */}
      <DialogContent
        title={t(`${kind}.title`)}
        description={t("draftNotice")}
        closeLabel={t("close")}
      >
        <LegalDocument kind={kind} />
      </DialogContent>
    </Dialog>
  );
}
