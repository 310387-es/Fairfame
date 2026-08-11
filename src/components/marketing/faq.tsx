import { useTranslations } from "next-intl";

/**
 * The five questions, as native disclosures.
 *
 * `<details>` rather than the concept's button-plus-max-height pair, and this
 * is a deliberate downgrade in machinery: the element already gives a keyboard
 * the toggle, a screen reader the expanded state, and find-in-page the ability
 * to open the panel it landed in — three behaviours the hand-rolled version
 * has to re-implement and the concept's version does not have. It also needs
 * no client bundle, which on a marketing page is the difference between the
 * answers being readable before hydration and after it.
 *
 * The `+` turning into a `×` is CSS on `[open]`, so it cannot fall out of step
 * with the element's real state — the failure mode of a rotation driven by a
 * class somebody has to remember to toggle.
 */

/* Literal key pairs, not `faq.q${n}` — see the note in `pillars.tsx`: a key
   assembled at runtime is a key the dead-string check cannot see. */
const QUESTIONS = [
  ["faq.q1", "faq.a1"],
  ["faq.q2", "faq.a2"],
  ["faq.q3", "faq.a3"],
  ["faq.q4", "faq.a4"],
  ["faq.q5", "faq.a5"],
] as const;

export function Faq() {
  const t = useTranslations("marketing");

  return (
    <div className="max-w-[880px]">
      {QUESTIONS.map(([question, answer]) => (
        <details key={question} className="faq-item border-b border-paper-line">
          <summary className="tap flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-lead font-semibold">
            {t(question)}
            <span aria-hidden className="faq-plus font-mono text-paper-faint transition-transform">
              +
            </span>
          </summary>
          <p className="max-w-[600px] pb-4 text-body text-paper-body">{t(answer)}</p>
        </details>
      ))}
    </div>
  );
}
