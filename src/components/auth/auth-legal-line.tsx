import { useTranslations } from "next-intl";
import { LegalDialog } from "@/components/legal/legal-dialog";

/**
 * The terms and KVKK line, at the point of collection (P5-T2).
 *
 * ## Why it is on both screens, not only sign-up
 *
 * The obvious reading is that consent belongs on the screen called sign-up.
 * It does not, because **"Continue with Google" on the sign-in screen creates
 * accounts too** — an OAuth arrival with no matching user is a signup wearing
 * a sign-in button. A line that appeared only on `/sign-up` would miss whoever
 * came in through the other door, which is most of the people this product
 * expects.
 *
 * ## Where it sits
 *
 * Below the submit button, which puts it below *both* routes: the Google button
 * is above the fields, so a single line underneath covers the whole card. One
 * statement rather than one per method — a screen that says the same sentence
 * twice reads as a form that is trying to get something past you.
 *
 * ## What it is not
 *
 * Not a checkbox. Accepting terms in order to have an account is a condition of
 * the service, and dressing a condition up as a choice is the dark pattern
 * KVKK's own guidance is about — a tick-box you cannot proceed without is not
 * consent, it is a click. The genuinely optional thing on this screen *is* a
 * checkbox, unticked, and it is a different question: `MarketingConsentField`.
 *
 * ## Two leads, one line
 *
 * The sentence differs by screen and it is not a nicety. "By creating an
 * account you accept…" is the truth on `/sign-up` and a small lie on
 * `/sign-in`, where most readers are returning customers who created theirs
 * months ago — and a consent notice that misdescribes what the reader is about
 * to do is the one kind of copy error that matters here. "By continuing" is
 * true of both routes on the sign-in screen: the returning customer, and the
 * person whose Google click is about to create an account.
 *
 * Two keys rather than one neutral sentence everywhere, because `/sign-up` can
 * afford to be specific and specificity is what makes a consent notice
 * meaningful.
 *
 * ## They open in place, not in a new page
 *
 * Both used to navigate, which meant a visitor half way through signing up who
 * wanted to check what they were agreeing to lost their name, their email and
 * their password. A consent notice that punishes reading it is one nobody
 * reads — the exact opposite of what putting it at the point of collection was
 * for. `LegalDialog` opens the document over the form, and there is no
 * standalone page: the notice is read here or not at all. That trade is argued
 * in `LegalDialog` itself.
 */
export function AuthLegalLine({
  /** `create` on the sign-up screen; `continue` where signing in is also possible. */
  lead = "create",
}: {
  lead?: "create" | "continue";
}) {
  const t = useTranslations("auth");

  return (
    <p className="mt-4 text-center text-copy text-pretty text-ink-400">
      {t.rich(lead === "create" ? "legalLine" : "legalLineContinue", {
        terms: (chunks) => <LegalDialog kind="terms" label={String(chunks)} />,
        privacy: (chunks) => <LegalDialog kind="kvkk" label={String(chunks)} />,
      })}
    </p>
  );
}
