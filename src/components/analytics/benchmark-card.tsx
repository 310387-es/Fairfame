"use client";

import { Info, Swords, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { SectionCard } from "@/components/ds/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAction } from "@/components/ui/use-action";
import { addCompetitorAction, removeCompetitorAction } from "@/server/competitors";

/**
 * Us against them (P3-T6), with the caveat that cannot be missed.
 *
 * **The notice is not decoration and must not be made subtler.** Until a real
 * connector lands, every competitor figure on this card is invented by
 * `src/competitors/source.ts`, and a benchmark is exactly the kind of number a
 * business repeats to a landlord or a supplier. `docs/19` asks for it to be
 * flagged clearly as unverified; this is that flag, rendered above the table
 * rather than under it, in the alarm colour, and it is driven by the data's own
 * `unverified` field rather than by the component guessing from a source name.
 *
 * The second honesty problem is subtler and permanent: **a listing shows a
 * lifetime rating**, so our side of the table is lifetime too. The Insights
 * range does not apply here and the copy says so — a 30-day average against
 * somebody's all-time one is the mistake that makes a business think it has
 * overtaken a rival.
 */

export type BenchmarkRowView = {
  competitorId: string;
  name: string;
  /** Preformatted server-side; null renders as a dash. */
  theirRating: string | null;
  theirReviews: string | null;
  gap: string | null;
  ahead: boolean | null;
};

export function BenchmarkCard({
  rows,
  ourRating,
  ourReviews,
  unverified,
  locked,
  canManage,
}: {
  rows: BenchmarkRowView[];
  ourRating: string | null;
  ourReviews: string;
  unverified: boolean;
  /** Non-null when the plan does not include benchmarking — the reason, in words. */
  locked: string | null;
  canManage: boolean;
}) {
  const t = useTranslations("insights");
  const tf = useTranslations("feedback");
  const [name, setName] = useState("");
  const [ref, setRef] = useState("");
  const { run, pending } = useAction();

  if (locked) {
    return (
      <SectionCard title={t("benchmark.title")} icon={Swords}>
        <p className="pb-(--card-py) text-body text-ink-400">{locked}</p>
      </SectionCard>
    );
  }

  const add = () => {
    run(() => addCompetitorAction({ name, provider: "google", externalRef: ref, locationId: "" }), {
      success: tf("created"),
      onSuccess: () => {
        setName("");
        setRef("");
      },
    });
  };

  const remove = (id: string) => {
    run(() => removeCompetitorAction({ id }), { success: tf("deleted") });
  };

  return (
    <SectionCard title={t("benchmark.title")} icon={Swords}>
      <div className="flex flex-col gap-4 pb-(--card-py)">
        {/*
          A caveat, not an alarm.

          This was a full-width red block with a warning triangle — the same
          treatment a failed payment gets — for the **expected** state of every
          deployment before go-live: `COMPETITOR_SOURCE` defaults to `none` and
          `fixtures` is what a developer sees. Red says "something has gone
          wrong and you should act"; nothing has gone wrong here, and there is
          nothing the reader can do about it, so the only thing the colour
          achieved was to make a working screen look broken.

          Quiet and neutral instead, with an `Info` mark. The words are
          unchanged and still say plainly that the numbers are samples — the
          honesty was never in the redness. `role="note"` so it is announced as
          an aside rather than left as an unlabelled paragraph.
        */}
        {unverified ? (
          <p
            role="note"
            className="flex items-start gap-2 rounded-md border border-line bg-surface-sunken px-3 py-2.5 text-copy text-ink-600"
          >
            <Info className="mt-0.5 size-4 shrink-0 text-graphic-faint" aria-hidden />
            <span>{t("benchmark.unverified")}</span>
          </p>
        ) : null}

        <p className="text-meta text-faint">{t("benchmark.basis")}</p>

        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-copy">
              <thead className="text-meta text-faint">
                <tr>
                  <th scope="col" className="py-2 font-medium">
                    {t("benchmark.who")}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t("column.rating")}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t("column.volume")}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t("benchmark.gap")}
                  </th>
                  {canManage ? <th scope="col" className="w-10 py-2" /> : null}
                </tr>
              </thead>
              <tbody>
                {/* Us first, so the row every other row is compared against is
                    the one the eye starts on. */}
                <tr className="border-t border-line-soft">
                  <th scope="row" className="py-2.5 font-semibold text-foreground">
                    {t("benchmark.you")}
                  </th>
                  <td className="py-2.5 text-right text-foreground tabular-nums">
                    {ourRating ?? "—"}
                  </td>
                  <td className="py-2.5 text-right text-foreground tabular-nums">{ourReviews}</td>
                  <td className="py-2.5 text-right text-faint">—</td>
                  {canManage ? <td /> : null}
                </tr>

                {rows.map((row) => (
                  <tr key={row.competitorId} className="border-t border-line-soft">
                    <th scope="row" className="py-2.5 font-medium text-ink-400">
                      {row.name}
                    </th>
                    <td className="py-2.5 text-right text-ink-400 tabular-nums">
                      {row.theirRating ?? "—"}
                    </td>
                    <td className="py-2.5 text-right text-ink-400 tabular-nums">
                      {row.theirReviews ?? "—"}
                    </td>
                    <td
                      className={`py-2.5 text-right tabular-nums ${
                        row.ahead === null
                          ? "text-faint"
                          : row.ahead
                            ? "text-primary"
                            : "text-destructive"
                      }`}
                    >
                      {row.gap ?? "—"}
                    </td>
                    {canManage ? (
                      <td className="py-2.5 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t("benchmark.remove", { name: row.name })}
                          onClick={() => remove(row.competitorId)}
                          disabled={pending}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-body text-ink-400">{t("benchmark.empty")}</p>
        )}

        {canManage ? (
          <div className="flex flex-wrap items-end gap-3 border-t border-line-soft pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="competitor-name">{t("benchmark.nameLabel")}</Label>
              <Input
                id="competitor-name"
                value={name}
                maxLength={80}
                placeholder={t("benchmark.namePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="competitor-ref">{t("benchmark.refLabel")}</Label>
              <Input
                id="competitor-ref"
                value={ref}
                maxLength={500}
                placeholder={t("benchmark.refPlaceholder")}
                onChange={(event) => setRef(event.target.value)}
              />
            </div>
            <Button type="button" onClick={add} disabled={pending || !name.trim() || !ref.trim()}>
              {t(pending ? "benchmark.adding" : "benchmark.add")}
            </Button>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
