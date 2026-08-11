import { useTranslations } from "next-intl";

/**
 * The rule between "Continue with Google" and the fields (P5-T1).
 *
 * A hairline with one word sitting in it, rather than a gap. The gap version
 * leaves two stacked controls that read as a sequence — fill this *and* press
 * that — where the truth is that they are alternatives, and a customer who
 * takes the top one has finished.
 *
 * The word is `aria-hidden` and the rule is a `<div>` rather than an `<hr>`:
 * to a screen reader this is a picture of a choice the page has already made
 * clear by having two labelled controls, and announcing "or" plus a separator
 * between them adds nothing a listener can act on.
 */
export function AuthDivider() {
  const t = useTranslations("auth");

  return (
    <div aria-hidden className="flex items-center gap-3">
      <span className="h-px flex-1 bg-line" />
      <span className="text-meta text-faint uppercase">{t("orDivider")}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
