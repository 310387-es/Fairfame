import { ClipboardList } from "lucide-react";
import Link from "next/link";
import { CardLink, SectionCard } from "@/components/ds/section-card";
import { Delta, Metric } from "@/components/ds/metric";
import { Eyebrow } from "@/components/ds/eyebrow";
import type { SurveyType } from "@/surveys/scoring";

/**
 * NPS and CSAT on the Insights workspace (P4-T2).
 *
 * `docs/20` asks that survey scores "feed insights", and this is where they
 * land: beside the rating and volume trends, because they answer the same
 * question from the other side. A rating is what people wrote in public; a
 * survey score is what they said when asked directly, and a business whose
 * public rating is holding while its NPS falls has learned something neither
 * number tells alone.
 *
 * Every string arrives formatted. The score is `null` — rendered as an em dash —
 * when nobody answered, never `0`: an NPS of zero is a real result, and showing
 * it for silence would be inventing a finding.
 */

export type SurveyScoreRow = {
  type: SurveyType;
  label: string;
  /** Already localised, or null when nothing was answered in this window. */
  value: string | null;
  responses: number;
  /** Fewer answers than the instrument needs to mean anything. */
  thin: boolean;
  /** Signed change against the previous window, or null when incomparable. */
  delta: string | null;
  /** Whether that change is an improvement. Null when there is no delta. */
  better: boolean | null;
};

export function SurveyScoreCard({
  title,
  note,
  thinSample,
  rows,
}: {
  title: string;
  note: string;
  thinSample: string;
  rows: SurveyScoreRow[];
}) {
  return (
    <SectionCard
      title={title}
      icon={ClipboardList}
      meta={note}
      action={
        <Link
          href="/surveys"
          className="rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <CardLink>{title}</CardLink>
        </Link>
      }
    >
      <div className="grid gap-4 pb-(--card-py) sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.type} className="flex flex-col gap-0.5">
            <Eyebrow>{row.label}</Eyebrow>
            <div className="flex items-baseline gap-2">
              <Metric>{row.value ?? "—"}</Metric>
              {row.delta && row.better !== null ? (
                <Delta direction={row.better} label={row.delta}>
                  {row.delta}
                </Delta>
              ) : null}
            </div>
            <p className="text-meta text-faint">{row.thin ? thinSample : `${row.responses}`}</p>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
