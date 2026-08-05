/**
 * WCAG 2.1 contrast, once.
 *
 * Extracted when the widget palette (P3-T0) needed the same maths as the
 * in-app palette. Two copies of a luminance formula is how you end up with two
 * answers for one colour pair, and the whole point of checking contrast in a
 * test is that the number is not a matter of opinion.
 *
 * Not in `src/`: nothing the product ships computes contrast at runtime. These
 * are the assertions' own tools.
 */

/** WCAG AA: 4.5:1 for body text, 3:1 for large text and non-text. */
export const AA_TEXT = 4.5;
export const AA_NON_TEXT = 3;

/** sRGB → relative luminance, per WCAG 2.1 §relative-luminance. */
export function luminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );

  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));

  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** Rounded the way the comments in globals.css write it. */
export function ratio(foreground: string, background: string): number {
  return Math.round(contrast(foreground, background) * 100) / 100;
}
