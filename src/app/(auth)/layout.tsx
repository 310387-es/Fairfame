import { ArrowRight } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";

/**
 * The pre-authentication screens.
 *
 * **What this replaces, and why it was worth replacing.** A 380px card centred
 * in 1440×900 of flat grey — the shadcn default, and the shape every product
 * has before somebody looks at it. It is the front door and the conversion
 * page, and it made no argument at all: the only positioning sentence on the
 * screen was the tagline, set at 11px in the faintest ink in the scale,
 * orphaned below the card where it read as a legal footer.
 *
 * A split puts the form where a form belongs and gives the empty half a job.
 *
 * **The panel invents nothing, deliberately.** The obvious move is a testimonial
 * or a screenshot of a fabricated business, and this product must not do that:
 * `docs/15` §7 says the imagery is the data, and a made-up review on the login
 * screen of a *review-management* tool is the exact thing the product exists to
 * stop people doing. So the panel says one true sentence and points at
 * `/sample`, which is a real briefing composed by the real pipeline over a
 * corpus that page labels as invented in its own words.
 *
 * The headline is `sample.title` itself rather than a paraphrase — one sentence
 * on two surfaces, so the promise made at the door and the page that keeps it
 * cannot drift apart.
 *
 * **Dark, because the product already is.** `--ink-900` is the rail and the
 * digest's hero card, so the panel reads as a piece of the application rather
 * than as marketing bolted onto it.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const [t, tSample] = await Promise.all([
    getTranslations("app"),
    // Borrowed on purpose — see above.
    getTranslations("sample"),
  ]);

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex flex-col items-center justify-center px-4 py-12">
        <Logo className="mb-8 [&>span:last-child]:text-xl" markClassName="size-8" />
        <div className="w-full max-w-sm">{children}</div>

        {/*
          Only where the panel is not. Below `lg` this is the sole line saying
          what the product is, so hiding it everywhere would trade one problem
          for a worse one on the screen most Turkish customers will use.
        */}
        <p className="mt-8 text-meta text-faint lg:hidden">{t("tagline")}</p>
      </div>

      <aside className="hidden bg-ink-900 lg:flex lg:flex-col lg:justify-center lg:px-16 xl:px-24">
        <div className="max-w-md">
          <p className="text-eyebrow text-on-ink-muted uppercase">{t("tagline")}</p>

          <h2 className="mt-3 text-display text-balance text-on-ink">{tSample("title")}</h2>

          <p className="mt-4 text-lead leading-relaxed text-pretty text-on-ink-muted">
            {t("authPanelBody")}
          </p>

          <Link
            href="/sample"
            className="mt-8 inline-flex items-center gap-2 text-body font-medium text-on-ink underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {t("authPanelLink")}
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
      </aside>
    </div>
  );
}
