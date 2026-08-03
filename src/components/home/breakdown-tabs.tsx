"use client";

import { Tags } from "lucide-react";
import { Tabs } from "radix-ui";
import type { ReactNode } from "react";
import { IconTile } from "@/components/ds/icon-tile";
import { segmentedItem, segmentedTrough } from "@/components/ds/segmented";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The "what customers said" card, with its three views behind a tab strip.
 *
 * Client state, not the URL. All three panels are rendered on the server from
 * the same already-loaded facts and shipped together, so switching is a CSS
 * change — no navigation, no refetch, no Suspense fallback flashing over a card
 * whose data never left the page. Putting this in the URL made every tap a
 * round trip to re-render a page that already had the answer.
 *
 * The range stays in the URL, because that genuinely changes what is fetched.
 * The rule is: the URL owns what the server needs to know, local state owns
 * which of several things already on the page you are looking at.
 *
 * Radix `Tabs` rather than three buttons: it gives the roving tabindex, arrow
 * and Home/End keys, and the `aria-controls`/`aria-selected` wiring that make a
 * tab strip navigable without a mouse.
 */
export type BreakdownTab = {
  value: string;
  label: string;
  panel: ReactNode;
};

export function BreakdownTabs({
  title,
  stripLabel,
  ribbon,
  tabs,
}: {
  title: string;
  /** Names the tab strip for assistive technology. */
  stripLabel: string;
  /** The sentiment ribbon, shared by all three views — it describes the
   *  period, not the cut, so it sits above the strip rather than inside a panel. */
  ribbon?: ReactNode;
  tabs: BreakdownTab[];
}) {
  return (
    <Tabs.Root defaultValue={tabs[0]?.value} asChild>
      <Card className="gap-0">
        <header className="flex items-center gap-2.5 px-(--card-px) pb-3">
          <IconTile icon={Tags} />
          <h2 className="text-title">{title}</h2>

          {/* Same styling as the link-based `Segmented`, from the same
              constants — the markup differs because the state does, but the two
              must never look like different controls. */}
          <Tabs.List aria-label={stripLabel} className={cn("ml-auto", segmentedTrough("sm"))}>
            {tabs.map((tab) => (
              <Tabs.Trigger
                key={tab.value}
                value={tab.value}
                className={cn(
                  segmentedItem("sm", false),
                  "data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm",
                )}
              >
                {tab.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </header>

        <div className="flex-1 px-(--card-px)">
          {ribbon}

          {tabs.map((tab) => (
            // `mt-4` on the panel rather than the ribbon, so the first row sits
            // the same distance below the header whether or not a ribbon showed.
            <Tabs.Content key={tab.value} value={tab.value} className="mt-4 outline-none">
              {tab.panel}
            </Tabs.Content>
          ))}
        </div>
      </Card>
    </Tabs.Root>
  );
}
