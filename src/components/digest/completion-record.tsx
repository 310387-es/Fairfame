import { CircleCheckBig } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Meter } from "@/components/ds/meter";
import { SectionCard } from "@/components/ds/section-card";
import type { CompletionRecord } from "@/digest/queries";
// From `prompts`, not from `digest/pipeline`, which re-exports it: the pipeline
// is the module that can spend money, and a component must not be able to reach
// it. Same rule that keeps generation out of `digest/queries.ts`.
import { DIGEST_LEVERS } from "@/prompts/index";

/**
 * What this business actually does with its briefings (W2.1).
 *
 * The Action Digest's promise is that it produces action, and the product had
 * no way to say whether it ever had. One card, on the surface where the claim
 * is made, reporting the only number that tests it.
 *
 * **The headline is a fraction, not a percentage.** "7 of 12" carries its own
 * sample size; "58%" does not, and over four briefings the denominator is
 * twelve — small enough that a single tick moves the percentage eight points
 * and makes a rate look like a trend. The bar beside it is the picture; the
 * fraction is the fact.
 *
 * The card **does not appear at all until there is a record to report** — a
 * business in its first fortnight gets no "0 of 3", which is not a finding about
 * them but a fact about how long they have been here.
 */
export async function CompletionRecordCard({ record }: { record: CompletionRecord }) {
  const t = await getTranslations("digest");

  // Nothing to say yet. The caller checks this too, so the card can also be
  // dropped before it is rendered; keeping it here means a new caller cannot
  // accidentally ship the empty state.
  if (record.total === 0) return null;

  const percent = Math.round((record.done / record.total) * 100);

  return (
    <SectionCard
      title={t("recordTitle")}
      icon={CircleCheckBig}
      meta={t("recordOver", { digests: record.digests })}
    >
      <p className="text-body">
        <span className="text-title font-semibold tabular-nums">
          {t("recordHeadline", { done: record.done, total: record.total })}
        </span>
      </p>

      <Meter
        className="mt-3"
        label={t("recordDone")}
        percent={percent}
        tone="positive"
        value={`${percent}%`}
        srLabel={t("recordSr", { done: record.done, total: record.total })}
      />

      {/* Dismissals sit outside the fraction, so they need saying explicitly —
          otherwise the totals do not reconcile with the three actions a reader
          remembers seeing each week, and an unexplained gap reads as a bug. */}
      {record.dismissed > 0 ? (
        <p className="mt-3 text-copy text-faint">
          {t("recordDismissed", { count: record.dismissed })}
        </p>
      ) : null}

      {/*
        Which kinds of action get finished. Two or more levers, because a single
        bar is not a comparison — it is the headline again, drawn wider.
      */}
      {record.byLever.length > 1 ? (
        <>
          <p className="mt-4 text-copy text-faint">{t("recordByLever")}</p>
          <div className="mt-2 flex flex-col gap-2">
            {record.byLever.map((entry) => (
              <Meter
                key={entry.lever}
                label={leverLabel(entry.lever, t)}
                percent={Math.round((entry.done / entry.total) * 100)}
                // The bare fraction, not the headline's sentence: in a column of
                // right-aligned values "1 of 1 actions done" is a paragraph.
                value={t("recordFraction", { done: entry.done, total: entry.total })}
                srLabel={t("recordLeverSr", {
                  lever: leverLabel(entry.lever, t),
                  done: entry.done,
                  total: entry.total,
                })}
              />
            ))}
          </div>
        </>
      ) : null}
    </SectionCard>
  );
}

/**
 * A lever's name in the reader's language.
 *
 * `lever` is stored as free text on purpose (the list is a prompt constraint
 * that will move), so a value from an older revision may have no key. It is
 * shown raw rather than dropped: an untranslated row is a smaller lie than a
 * breakdown that silently omits work the business did.
 */
function leverLabel(lever: string, t: Awaited<ReturnType<typeof getTranslations<"digest">>>) {
  return (DIGEST_LEVERS as readonly string[]).includes(lever)
    ? t(`lever.${lever}` as Parameters<typeof t>[0])
    : lever;
}
