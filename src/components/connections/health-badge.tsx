import { getTranslations } from "next-intl/server";
import type { ConnectionHealth } from "@/connections/health";
import { cn } from "@/lib/utils";

/**
 * A connection's health, in one word (W4.2).
 *
 * The tones are the argument, not decoration. `healthy` is deliberately quiet —
 * a grey chip, not a green one — because a screen where every working source
 * shouts is a screen where the one broken source does not stand out. Green is
 * spent on nothing here; the colour budget goes entirely to the states that
 * need somebody.
 *
 * `limited` is amber rather than red: nobody does anything about a rate limit,
 * it resolves itself, and it is on the card only so that "why is this behind"
 * has an answer that is not "it is broken".
 */

const TONES: Record<ConnectionHealth, string> = {
  healthy: "bg-surface-sunken text-ink-500",
  setup: "bg-state-accent-bg text-state-accent-text",
  limited: "bg-state-rating-bg text-state-rating-text",
  stale: "bg-state-rating-bg text-state-rating-text",
  reconnect: "bg-state-negative-bg text-state-negative-text",
  failing: "bg-state-negative-bg text-state-negative-text",
};

export async function HealthBadge({
  health,
  className,
}: {
  health: ConnectionHealth;
  className?: string;
}) {
  const t = await getTranslations("connections");

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-meta font-medium",
        TONES[health],
        className,
      )}
    >
      {t(`health.${health}`)}
    </span>
  );
}
