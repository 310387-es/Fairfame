import { getTranslations } from "next-intl/server";
import { Segmented } from "@/components/ds/segmented";
import { sectionFor, type SectionTab } from "@/lib/sections";

/**
 * The two screens that left the rail and became tabs (W3.1).
 *
 * Campaigns sat beside Contacts in the rail and Surveys beside Get reviews, as
 * though each were its own department. They are not: a campaign is how you
 * reach the people in Contacts, and a survey is another way of asking what a
 * review request asks. Two entries each made the rail longer and the
 * relationship invisible.
 *
 * **A tab strip, not a nested route.** The pages keep their own URLs — they are
 * bookmarked, linked from emails, and `revalidatePath` names them — so nothing
 * moves. This only changes how somebody *finds* the second one, which was the
 * complaint.
 *
 * `Segmented` rather than a bespoke tab bar: it is already the product's "two
 * or three views of the same thing" control (the Inbox's sort, the Insights
 * range), it renders as links so a tab can be opened in a new window, and it
 * carries `aria-current` for free.
 */

export async function SectionTabs({ active }: { active: SectionTab }) {
  const t = await getTranslations("tabs");

  // From `src/lib/sections.ts`, which the rail also reads — so a tab added
  // here can never be a tab the rail does not know how to stay lit for.
  const section = sectionFor(active);
  if (!section) return null;

  return (
    <Segmented
      label={t("label")}
      size="sm"
      className="mb-(--grid-gap)"
      items={section.tabs.map((tab) => ({
        href: tab.href,
        label: t(tab.key),
        active: tab.key === active,
      }))}
    />
  );
}
