/**
 * Brand marks for the Connections screen (W4.2).
 *
 * ## Why these are drawn rather than imported
 *
 * The audit asks for "real logos", and the two obvious ways to get them are
 * both wrong here. Loading them from a CDN is impossible on a page served under
 * this app's CSP and would leak a request to a third party on every render.
 * Committing traced brand assets means shipping somebody else's trademark files
 * into the repository and keeping them current forever.
 *
 * So each mark is **constructed from geometry** — the shapes the marks are
 * actually made of, in the brands' own colours. Instagram genuinely is a
 * rounded square, a circle and a dot; Google's G genuinely is four coloured
 * arcs and a bar; Tripadvisor genuinely is two eyes. Where a mark cannot be
 * built honestly from primitives (the Turkish delivery platforms, whose marks
 * are wordmarks) it is a **monogram on the brand's colour**, which reads as a
 * deliberate identifier rather than as a bad tracing.
 *
 * This is nominative use — identifying which service an integration connects
 * to — which is what every integrations directory does. No mark is used as our
 * own, and none is placed on anything a customer's visitor sees.
 *
 * **`firstparty` is the exception, and it proves the rule**: that tile is our
 * own seal, so it is the shipped asset rather than geometry. The whole argument
 * above is about artwork we have no right to commit; there is no such argument
 * against our own, and there is a strong one against re-drawing it.
 *
 * ## Rules for adding one
 *
 * Server-renderable (no `"use client"`, no hooks), sized entirely by the `size`
 * prop, and `aria-hidden` — the provider's name is always beside it as text, so
 * a screen reader announcing the mark as well would read every source twice.
 */

import { LogoMark } from "@/components/brand/logo";

export type ProviderMarkProps = { provider: string; size?: number };

/** Brand colours, from each brand's own guidelines. */
const BRAND = {
  google: { blue: "#4285F4", red: "#EA4335", yellow: "#FBBC05", green: "#34A853" },
  whatsapp: "#25D366",
  facebook: "#0866FF",
  trustpilot: "#00B67A",
  tripadvisor: "#34E0A1",
  yemeksepeti: "#FA0050",
  getir: "#5D3EBC",
  trendyol: "#F27A1A",
} as const;

export function ProviderMark({ provider, size = 32 }: ProviderMarkProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 32 32",
    "aria-hidden": true,
    focusable: false,
  } as const;

  switch (provider) {
    /**
     * The four-colour G. Built as four arcs of one circle plus the crossbar,
     * which is how the mark is constructed — the arc endpoints are the brand's
     * own quadrant breaks, so this is a reconstruction rather than an
     * impression of one.
     */
    case "google":
      return (
        <svg {...common}>
          <path
            d="M28 16.3c0-.9-.1-1.8-.2-2.6H16v5h6.7a5.8 5.8 0 0 1-2.5 3.8v3.2h4.1c2.4-2.2 3.7-5.4 3.7-9.4Z"
            fill={BRAND.google.blue}
          />
          <path
            d="M16 29c3.2 0 6-1.1 8-3l-4.1-3.2c-1.1.8-2.5 1.2-3.9 1.2-3 0-5.6-2-6.5-4.8H5.3v3.3A12 12 0 0 0 16 29Z"
            fill={BRAND.google.green}
          />
          <path
            d="M9.5 19.2a7 7 0 0 1 0-4.6v-3.3H5.3a12 12 0 0 0 0 11.2l4.2-3.3Z"
            fill={BRAND.google.yellow}
          />
          <path
            d="M16 8.6c1.7 0 3.3.6 4.5 1.8l3.6-3.6A12 12 0 0 0 5.3 11.3l4.2 3.3c1-2.9 3.5-4.9 6.5-4.9Z"
            fill={BRAND.google.red}
          />
        </svg>
      );

    case "whatsapp":
      return (
        <svg {...common}>
          <path
            d="M16 3a13 13 0 0 0-11.2 19.5L3 29l6.7-1.7A13 13 0 1 0 16 3Z"
            fill={BRAND.whatsapp}
          />
          {/* The handset, as the mark's own rounded L-sweep. */}
          <path
            d="M12.2 10.2c-.3-.7-.6-.7-.9-.7h-.8c-.3 0-.7.1-1.1.5-.4.4-1.4 1.4-1.4 3.3s1.4 3.8 1.6 4.1c.2.3 2.8 4.4 6.9 6 3.4 1.3 4.1 1 4.9.9.7-.1 2.3-1 2.6-1.9.3-.9.3-1.7.2-1.9-.1-.2-.4-.3-.8-.5l-2.8-1.4c-.4-.1-.7-.2-.9.2l-1.3 1.6c-.2.3-.5.3-.9.1-.4-.2-1.8-.7-3.5-2.2-1.3-1.1-2.1-2.6-2.4-3-.2-.4 0-.6.2-.8l.6-.7c.2-.3.3-.4.4-.7.1-.3.1-.5 0-.7l-1.1-2.3Z"
            fill="#fff"
          />
        </svg>
      );

    /**
     * Instagram: the gradient rounded square, the rounded-square outline, the
     * lens and the flash dot. All four are real elements of the mark.
     */
    case "instagram":
      return (
        <svg {...common}>
          <defs>
            <linearGradient id="ig-mark" x1="0" y1="32" x2="32" y2="0">
              <stop offset="0" stopColor="#FFD521" />
              <stop offset="0.35" stopColor="#F50000" />
              <stop offset="0.7" stopColor="#B900B4" />
              <stop offset="1" stopColor="#4D01A6" />
            </linearGradient>
          </defs>
          <rect width="32" height="32" rx="9" fill="url(#ig-mark)" />
          <rect
            x="7.5"
            y="7.5"
            width="17"
            height="17"
            rx="5.5"
            fill="none"
            stroke="#fff"
            strokeWidth="2"
          />
          <circle cx="16" cy="16" r="4.2" fill="none" stroke="#fff" strokeWidth="2" />
          <circle cx="21.6" cy="10.4" r="1.3" fill="#fff" />
        </svg>
      );

    case "facebook":
      return (
        <svg {...common}>
          <circle cx="16" cy="16" r="13" fill={BRAND.facebook} />
          <path
            d="M19.4 17.3l.6-3.7h-3.6v-2.4c0-1 .5-2 2.1-2H20V5.9s-1.4-.3-2.8-.3c-2.9 0-4.8 1.8-4.8 4.9v2.8H9.2v3.7h3.2V29a13 13 0 0 0 4 0v-9.4h2.9Z"
            fill="#fff"
          />
        </svg>
      );

    /** Trustpilot: the green field and the five-point star. */
    case "trustpilot":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="7" fill={BRAND.trustpilot} />
          <path
            d="M16 6.5l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6-5.9-3.2-5.9 3.2 1.2-6.6-4.8-4.6 6.6-.9L16 6.5Z"
            fill="#fff"
          />
        </svg>
      );

    /** Tripadvisor: the two eyes, which is what the modern mark is. */
    case "tripadvisor":
      return (
        <svg {...common}>
          <rect width="32" height="32" rx="7" fill="#000" />
          <circle cx="11" cy="17" r="5.6" fill="none" stroke={BRAND.tripadvisor} strokeWidth="2" />
          <circle cx="21" cy="17" r="5.6" fill="none" stroke={BRAND.tripadvisor} strokeWidth="2" />
          <circle cx="11" cy="17" r="2.1" fill={BRAND.tripadvisor} />
          <circle cx="21" cy="17" r="2.1" fill={BRAND.tripadvisor} />
          {/* The beak. */}
          <path
            d="M11 9.6c1.7-1.1 3.3-1.6 5-1.6s3.3.5 5 1.6"
            fill="none"
            stroke={BRAND.tripadvisor}
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );

    /**
     * The Turkish delivery platforms. Their marks are wordmarks, so a monogram
     * on the brand colour is the honest version — recognisable by colour, and
     * plainly ours rather than a poor copy of theirs.
     */
    case "yemeksepeti":
      return <Monogram letter="ye" fill={BRAND.yemeksepeti} size={size} />;
    case "getir":
      return <Monogram letter="g" fill={BRAND.getir} size={size} />;
    case "trendyol_yemek":
      return <Monogram letter="ty" fill={BRAND.trendyol} size={size} />;

    /**
     * Our own sources. `firstparty` is the hosted collection page, which is
     * this product — so it wears this product's mark rather than borrowing a
     * generic globe.
     *
     * The one mark on this screen that is *not* constructed from geometry, and
     * the reason is the reason at the top of this file read backwards: every
     * other tile is drawn because shipping somebody else's artwork is the wrong
     * thing to do with a trademark we do not own. This one is ours, the artwork
     * is in the repository already, and drawing our own seal by hand would be
     * inventing a second version of the logo (docs/24 §2). It replaced an "R"
     * monogram in a fifth indigo that was never in the palette.
     */
    case "firstparty":
      return <LogoMark size={size} />;

    default:
      // Development connectors and anything added to `PROVIDERS` without a mark
      // here. Neutral rather than absent: a missing tile would collapse the
      // card's layout, and a grey initial reads as "no brand" instead of "bug".
      return <Monogram letter={provider.slice(0, 1).toUpperCase()} fill="#64748B" size={size} />;
  }
}

function Monogram({ letter, fill, size }: { letter: string; fill: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <rect width="32" height="32" rx="7" fill={fill} />
      <text
        x="16"
        y="16"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#fff"
        fontFamily="system-ui, sans-serif"
        fontSize={letter.length > 1 ? 12 : 16}
        fontWeight="700"
      >
        {letter}
      </text>
    </svg>
  );
}
