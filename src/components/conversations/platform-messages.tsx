import { Inbox } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Avatar } from "@/components/ds/avatar";
import { SectionCard } from "@/components/ds/section-card";
import { sourceLabel } from "@/connectors/source-label";
import type { DirectMessageItem } from "@/reviews/direct-messages";

/**
 * Direct messages a *connector* brought in (A22-C1).
 *
 * These sat in the review queue, counted as reviews, on the screen whose header
 * is a count of reviews — and a private note asking whether a black umbrella had
 * been handed in was clustered into a theme and printed in the weekly plan. They
 * are not reviews, so they left that queue; the one thing that must never happen
 * is their becoming unreachable, and this is where they went.
 *
 * **Beside the conversations rather than inside them**, because they are not the
 * same object. A conversation is a thread with a *contact* you can write back to
 * inside a window; these arrive with an author's name, no contact, and no way to
 * answer — the reply composer already refuses a DM for exactly that reason.
 * Merging them into the list would put rows in it that none of its controls
 * work on.
 *
 * Read-only, and outside the `messaging` entitlement: a business that has not
 * bought messaging can still be *sent* a message, and hiding what somebody wrote
 * to them behind a plan would be the same disappearance in a different costume.
 */
export async function PlatformMessages({ items }: { items: DirectMessageItem[] }) {
  const [t, format] = await Promise.all([getTranslations("messages.platform"), getFormatter()]);

  if (items.length === 0) return null;

  const now = new Date();

  return (
    <SectionCard title={t("title")} icon={Inbox} meta={t("readOnly")} flush>
      <ul className="divide-y divide-line-soft">
        {items.map((item) => (
          <li key={item.id} className="flex gap-3 px-(--card-px) py-3">
            <Avatar name={item.authorName} className="mt-0.5 size-6 shrink-0" />

            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 text-copy">
                <span className="font-semibold text-foreground">
                  {item.authorName ?? t("unnamed")}
                </span>
                <span className="text-faint">{sourceLabel(item.source)}</span>
                <time
                  dateTime={item.at.toISOString()}
                  className="ml-auto shrink-0 text-meta text-faint"
                >
                  {format.relativeTime(item.at, now)}
                </time>
              </p>
              <p className="mt-0.5 text-body text-pretty text-ink-600">{item.text}</p>
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
