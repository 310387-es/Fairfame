import { useTranslations } from "next-intl";
import { Stars } from "@/components/ds/stars";
import { Reveal } from "@/components/marketing/reveal";
import { cn } from "@/lib/utils";

/**
 * The bento: what you get, one cell per job, each with a vignette.
 *
 * ## Why every cell carries a small picture
 *
 * A grid of nine title-and-paragraph cards is the arrangement this page's
 * whole design is a reaction against — it asks the reader to take nine claims
 * on trust in a row. The vignettes are the smallest possible evidence: not
 * screenshots (which go stale and need re-shooting per locale) but the shape
 * of the thing itself, drawn in the product's own tokens, in the reader's own
 * language. A consent chip, a draft with its two buttons, an NPS row with one
 * score lit.
 *
 * They are **decorative in the accessibility sense and marked so**. Every one
 * restates its cell's heading and body in picture form and adds no fact that
 * is not already in the text beside it, so exposing them to a screen reader
 * would be nine repetitions of what it just read. `aria-hidden` here is the
 * honest label, not a way around the contrast rule — the text they contain
 * clears AA on its own, and `e2e/contrast.spec.ts` measures them anyway
 * because it walks the rendered page rather than the source.
 *
 * ## Two deliberate departures from the landing concept
 *
 * **The benchmark vignette compares two branches, not two companies.** The
 * concept drew a meter labelled "Fairfame" at 86% against an anonymous "~" at
 * 64%, which reads as a comparative claim about us and is one — `PRODUCT.md`
 * forbids exactly that shape of figure. It is also not what the feature does:
 * the product scores a *business's* locations, not itself. Two branch names
 * make the same picture say something true.
 *
 * **The rating badge's figure is a message, not a literal.** "4,8" is written
 * with a comma in Turkish and a point in English, and a hardcoded string gets
 * one of the two wrong on a page whose whole pitch is that Turkish is not a
 * translation.
 */

/** A cell's illustration. Decorative — see the note above. */
function Viz({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div aria-hidden className={cn("mt-auto pt-4", className)}>
      {children}
    </div>
  );
}

function VChip({ children, ok = false }: { children: React.ReactNode; ok?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-md border px-1.5 py-0.5 text-meta font-semibold",
        ok
          ? "border-state-positive-bg bg-state-positive-bg text-state-positive-text"
          : "border-line bg-white text-paper-body",
      )}
    >
      {children}
    </span>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-line bg-white px-2 py-0.5 text-meta font-semibold text-paper-body">
      {children}
    </span>
  );
}

/**
 * The nine cells.
 *
 * Keys are written out in full rather than built from the cell's name,
 * because `scripts/check-i18n.mts` can only see a key it can read as a
 * literal — and a catalogue entry that no static check can find is one nobody
 * dares delete. The repetition buys a dead-string check that actually works.
 */
const PILLARS = [
  { id: "digest", title: "features.digestTitle", body: "features.digestBody", wide: true },
  { id: "collect", title: "features.collectTitle", body: "features.collectBody", wide: false },
  { id: "reply", title: "features.replyTitle", body: "features.replyBody", wide: false },
  { id: "engage", title: "features.engageTitle", body: "features.engageBody", wide: false },
  { id: "show", title: "features.showTitle", body: "features.showBody", wide: false },
  { id: "analyze", title: "features.analyzeTitle", body: "features.analyzeBody", wide: false },
  { id: "teams", title: "features.teamsTitle", body: "features.teamsBody", wide: false },
  { id: "phone", title: "features.phoneTitle", body: "features.phoneBody", wide: false },
] as const;

export function Pillars() {
  const t = useTranslations("marketing");

  const vignettes: Record<(typeof PILLARS)[number]["id"], React.ReactNode> = {
    digest: (
      <Viz>
        <ol className="flex flex-col gap-2">
          {(["digest.two", "digest.three"] as const).map((key, index) => (
            <li key={key} className="flex gap-2.5">
              <span className="w-4 flex-none font-mono text-copy font-bold text-amber-ink">
                {index + 1}
              </span>
              <span className="text-copy">{t(key)}</span>
            </li>
          ))}
        </ol>
      </Viz>
    ),
    collect: (
      <Viz>
        <div className="mb-2 flex flex-wrap gap-1.5">
          <VChip>QR</VChip>
          <VChip>SMS</VChip>
          <VChip>{t("channel.email")}</VChip>
          <VChip>WhatsApp</VChip>
          <VChip ok>{t("vignette.consent")}</VChip>
        </div>
        <span className="inline-block max-w-full rounded-xl rounded-bl-[3px] border border-line bg-surface-sunken px-2.5 py-2 text-copy">
          {t("vignette.request")}
        </span>
      </Viz>
    ),
    reply: (
      <Viz>
        <div className="rounded-[9px] border border-line bg-surface-sunken px-2.5 py-2.5 text-copy">
          {t("vignette.draft")}
          <div className="mt-2 flex gap-1.5">
            <span className="rounded-md border border-line bg-white px-2 py-1 text-meta font-semibold">
              {t("draft.edit")}
            </span>
            <span className="rounded-md border border-indigo-600 bg-indigo-600 px-2 py-1 text-meta font-semibold text-white">
              {t("draft.approve")}
            </span>
          </div>
        </div>
      </Viz>
    ),
    engage: (
      <Viz className="flex items-center gap-1">
        <span className="me-1 text-meta font-bold text-paper-faint">{t("vignette.nps")}</span>
        {[6, 7, 8, 9, 10].map((n) => (
          <span
            key={n}
            className={cn(
              "flex size-5 items-center justify-center rounded font-mono text-meta",
              n === 9
                ? "bg-amber-500 font-bold text-brand-rail"
                : "bg-surface-sunken text-paper-faint",
            )}
          >
            {n}
          </span>
        ))}
      </Viz>
    ),
    show: (
      <Viz>
        <span className="inline-flex items-center gap-2 rounded-[10px] border border-paper-line bg-paper px-3 py-2 font-semibold tabular-nums">
          <Stars rating={4} srLabel="" size="sm" />
          {t("vignette.badge")}
        </span>
      </Viz>
    ),
    analyze: (
      <Viz>
        {(
          [
            { name: "vignette.locationOne", width: "86%", tone: "bg-amber-500" },
            { name: "vignette.locationTwo", width: "64%", tone: "bg-graphic-faint" },
          ] as const
        ).map(({ name, width, tone }) => (
          <div key={name} className="mt-2 first:mt-0">
            <div className="text-meta text-paper-faint">{t(name)}</div>
            <div className="mt-1 h-2 overflow-hidden rounded-[5px] bg-surface-sunken">
              <span className={cn("block h-full rounded-[5px]", tone)} style={{ width }} />
            </div>
          </div>
        ))}
      </Viz>
    ),
    teams: (
      <Viz className="flex flex-wrap items-center gap-1.5">
        {["EY", "MC", "SD"].map((initials, index) => (
          <span
            key={initials}
            className={cn(
              "flex size-6 items-center justify-center rounded-full border-[1.5px] border-white bg-indigo-050 text-meta font-bold text-indigo-600",
              index > 0 && "-ms-3.5",
            )}
          >
            {initials}
          </span>
        ))}
        <Pill>{t("vignette.sla")}</Pill>
        <Pill>{t("vignette.locationOne")}</Pill>
        <Pill>{t("vignette.locationTwo")}</Pill>
      </Viz>
    ),
    phone: (
      <Viz>
        <div className="max-w-[230px] rounded-xl border-[1.5px] border-paper-line bg-white p-2">
          <div className="flex items-center gap-2 rounded-lg bg-surface-sunken px-2.5 py-2 text-meta">
            <span className="size-2 flex-none rounded-full bg-amber-500" />
            {t("vignette.push")}
          </div>
        </div>
      </Viz>
    ),
  };

  return (
    <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
      {PILLARS.map(({ id, title, body, wide }) => (
        <Reveal key={id} className={wide ? "lg:col-span-2" : undefined}>
          <div className="flex h-full flex-col rounded-2xl border border-paper-line bg-white p-6 transition-colors hover:border-brand-ink">
            <h3 className="mb-1.5 text-lead font-semibold">{t(title)}</h3>
            <p className="text-copy text-paper-body">{t(body)}</p>
            {vignettes[id]}
          </div>
        </Reveal>
      ))}

      {/* The compliance cell runs the full width and takes the ink border: it
          is the page's one non-negotiable, and the two rules `docs/20` keeps
          in code rather than in policy are what it points at. */}
      <Reveal className="lg:col-span-3">
        <div className="h-full rounded-2xl border border-brand-ink bg-white p-6">
          <h3 className="mb-1.5 text-lead font-semibold">{t("features.honestTitle")}</h3>
          <p className="max-w-[760px] text-copy text-paper-body">{t("features.honestBody")}</p>
          {/* Not decorative: these are the three honest source labels the FAQ's
              fifth answer refers to, and they are the claim rather than a
              picture of it. */}
          <div className="mt-4 flex flex-wrap gap-2">
            {(["vignette.live", "vignette.monitor", "vignette.display"] as const).map((label) => (
              <span
                key={label}
                className="rounded-full border border-paper-line bg-white px-2.5 py-1 text-meta font-semibold text-paper-body"
              >
                {t(label)}
              </span>
            ))}
          </div>
        </div>
      </Reveal>
    </div>
  );
}
