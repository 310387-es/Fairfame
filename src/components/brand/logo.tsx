import { cn } from "@/lib/utils";

/**
 * The Revira monogram: an indigo "R" tile with a live-notification dot.
 *
 * Direction chosen in docs/08-design-brief.md §2 and drawn from concept B in
 * docs/assets/revira-logo-concepts.svg. The reference sets the "R" as an SVG
 * <text> element, which would depend on Poppins being installed and render
 * differently on every machine — fatal for a favicon. The letterform here is
 * drawn as geometry instead, so it is identical everywhere and scales cleanly
 * down to 16px.
 *
 * Colours are literal brand hex rather than theme tokens: a logo must not
 * change hue with the surrounding UI.
 */

const INDIGO = "#3D5AF1";
const AMBER = "#F5A524";

export function LogoMark({
  className,
  /** Ring around the notification dot — set to the surface it sits on. */
  ringColor = "#FFFFFF",
  title,
}: {
  className?: string;
  ringColor?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 96 96"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0", className)}
    >
      {title ? <title>{title}</title> : null}

      <rect x="6" y="6" width="84" height="84" rx="22" fill={INDIGO} />

      {/* Geometric R: stem, bowl, leg. Round joins keep it friendly rather
          than severe, matching the "calm, confident" personality. */}
      <g stroke="#FFFFFF" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M33 26 V70" />
        <path d="M33 26 H52 A11 11 0 0 1 52 48 H33" />
        <path d="M45 48 L62 70" />
      </g>

      {/* The live dot — the product is about reviews arriving. */}
      <circle cx="76" cy="20" r="11" fill={AMBER} stroke={ringColor} strokeWidth="4" />
    </svg>
  );
}

/** Mark plus wordmark, for headers and auth screens. */
export function Logo({
  className,
  markClassName,
  ringColor,
}: {
  className?: string;
  markClassName?: string;
  ringColor?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <LogoMark className={cn("size-7", markClassName)} ringColor={ringColor} title="Revira" />
      <span className="text-base font-semibold tracking-tight">Revira</span>
    </span>
  );
}
