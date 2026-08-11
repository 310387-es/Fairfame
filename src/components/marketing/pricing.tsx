import { useTranslations } from "next-intl";
import { HashLink } from "@/components/marketing/hash-link";
import { Reveal } from "@/components/marketing/reveal";
import { cn } from "@/lib/utils";

/**
 * The public price ladder (`PRODUCT.md` §Commercial Facts).
 *
 * "Transparent public pricing is a positioning pillar" is the reason this
 * section exists at all, and the reason the FAQ repeats the figures: a page
 * that puts numbers behind a demo request contradicts the product it is
 * selling. The section's own headline says so.
 *
 * ## The four things this must not get wrong
 *
 * **There is no free tier.** Every plan starts with a 14-day full-feature
 * trial, which is a different offer, and `PRODUCT.md` forbids the words "free
 * plan" anywhere. The trial grants top-tier entitlements — that is why the
 * sub-line calls it full-feature rather than a trial of Starter.
 *
 * **Billing is per location, per month**, and the unit is on the price rather
 * than in a footnote, because a monthly figure that turns out to be per branch
 * at checkout is the kind of surprise this page is positioned against.
 *
 * **Agency is not the top of the ladder.** It is a different shape — priced
 * per deal, sold to a different buyer — so it carries no figure and its call
 * to action is a conversation rather than a trial. `docs/20` treats agencies
 * as a first-class audience, not an enterprise upsell.
 *
 * **The footnote is load-bearing.** Repricing and metered add-ons are stated
 * here, once, in the place the number is. Sends and heavy AI use are real
 * marginal cost; saying so beside the price is the honest version of a plan
 * that would otherwise have to hide the ceiling.
 *
 * The figures live in the message catalogue rather than in this file because
 * they differ per audience — the catalogue is the one place a price is
 * written, and `pnpm check:i18n` proves both locales carry the same set.
 */

/**
 * Every key written out rather than assembled from the tier's name.
 *
 * `scripts/check-i18n.mts` can only see a key it can read as a literal, and a
 * price nothing can prove is referenced is a price nobody dares delete when
 * the packaging changes. The repetition is what makes the dead-string check
 * work on the four strings on this page that cost money to get wrong.
 */
const TIERS = [
  {
    id: "starter",
    name: "pricing.starterName",
    price: "pricing.starterPrice",
    features: [
      "pricing.starterOne",
      "pricing.starterTwo",
      "pricing.starterThree",
      "pricing.starterFour",
    ],
    featured: false,
  },
  {
    id: "growth",
    name: "pricing.growthName",
    price: "pricing.growthPrice",
    features: [
      "pricing.growthOne",
      "pricing.growthTwo",
      "pricing.growthThree",
      "pricing.growthFour",
    ],
    featured: true,
  },
  {
    id: "pro",
    name: "pricing.proName",
    price: "pricing.proPrice",
    features: ["pricing.proOne", "pricing.proTwo", "pricing.proThree", "pricing.proFour"],
    featured: false,
  },
  {
    id: "agency",
    name: "pricing.agencyName",
    price: "pricing.agencyPrice",
    features: [
      "pricing.agencyOne",
      "pricing.agencyTwo",
      "pricing.agencyThree",
      "pricing.agencyFour",
    ],
    featured: false,
  },
] as const;

export function Pricing() {
  const t = useTranslations("marketing");

  return (
    <div className="grid items-stretch gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
      {TIERS.map(({ id, name, price, features, featured }) => {
        const agency = id === "agency";
        return (
          <Reveal key={id}>
            <div
              className={cn(
                "relative flex h-full flex-col rounded-2xl border bg-white p-6",
                featured ? "border-brand-ink" : "border-paper-line",
              )}
            >
              {featured && (
                <span className="absolute start-5 -top-2.5 rounded-md bg-amber-500 px-2.5 py-0.5 text-eyebrow font-bold text-brand-rail uppercase">
                  {t("pricing.growthBadge")}
                </span>
              )}

              <h3 className="mb-2 text-lead font-semibold">{t(name)}</h3>

              <p className="mb-3.5">
                <span className="text-display tabular-nums">{t(price)}</span>{" "}
                {/* Agency carries no per-location unit: it is priced per deal,
                    and appending "/ location · month" to "Per deal" would state
                    a billing model that does not exist. */}
                {!agency && (
                  <span className="text-meta text-paper-faint">{t("pricing.perLocation")}</span>
                )}
              </p>

              <ul className="mb-4 flex flex-1 flex-col gap-2">
                {features.map((feature) => (
                  <li key={feature} className="relative ps-4 text-copy text-paper-body">
                    <span aria-hidden className="absolute start-0 text-amber-ink">
                      —
                    </span>
                    {t(feature)}
                  </li>
                ))}
              </ul>

              <HashLink
                href="#cta"
                className={cn(
                  "tap justify-center rounded-[10px] border px-3.5 py-2.5 text-center text-copy font-semibold",
                  featured
                    ? "border-brand-ink bg-brand-ink text-white"
                    : "border-paper-line hover:border-brand-ink",
                )}
              >
                {agency ? t("agency.cta") : t("hero.cta1")}
              </HashLink>
            </div>
          </Reveal>
        );
      })}
    </div>
  );
}
