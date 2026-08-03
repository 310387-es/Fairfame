import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A rounded square with a tinted wash behind a Lucide glyph.
 *
 * How a card header or a feed row is marked. The tone is not decoration — it
 * says what kind of thing this is, and the mapping is fixed across the app so
 * an amber tile means "rating" on Home and still means "rating" in the digest:
 *
 *   muted    a neutral widget, no judgement implied
 *   accent   an action, a reply, something the product did
 *   rating   stars and rating movement
 *   negative the attention queue — things going wrong
 *   solid    the AI briefing, and nothing else
 *
 * `solid` is deliberately scarce. It is the only filled indigo tile in the
 * product, which is what makes the briefing bar read as the page's one voice
 * rather than as another widget.
 */
const TONES = {
  muted: "bg-surface-sunken text-ink-400",
  accent: "bg-state-accent-bg text-state-accent-text",
  rating: "bg-state-rating-bg text-state-rating-text",
  negative: "bg-state-negative-bg text-state-negative-text",
  solid: "bg-primary text-primary-foreground",
} as const;

const SIZES = {
  /** In a feed row or a list item. */
  sm: "size-6 rounded-sm [&>svg]:size-3.5",
  /** In a card header — the default. */
  md: "size-[22px] rounded-sm [&>svg]:size-3.5",
  /** On the briefing bar. */
  lg: "size-[38px] rounded-[11px] [&>svg]:size-[19px]",
} as const;

export type IconTileProps = {
  icon: LucideIcon;
  tone?: keyof typeof TONES;
  size?: keyof typeof SIZES;
  className?: string;
};

export function IconTile({ icon: Icon, tone = "muted", size = "md", className }: IconTileProps) {
  return (
    <span
      // Decorative by definition: the adjacent title already names the thing,
      // and a screen reader announcing "chart icon, Reputation over time" is
      // noise. If a tile is ever the only label, that is the bug.
      aria-hidden
      className={cn("grid shrink-0 place-items-center", TONES[tone], SIZES[size], className)}
    >
      <Icon strokeWidth={2} />
    </span>
  );
}
