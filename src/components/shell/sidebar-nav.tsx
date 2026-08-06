"use client";

import {
  Building2,
  CalendarRange,
  Contact,
  Home,
  Inbox,
  LayoutGrid,
  LineChart,
  MapPin,
  MessageSquare,
  Radio,
  Send,
  Settings,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { railParentFor } from "@/lib/sections";
import { cn } from "@/lib/utils";

/**
 * Left-rail navigation, grouped by what you came here to do.
 *
 * Seven equal links in one flat list made every destination cost the same
 * glance, which is wrong: Home and Inbox are opened many times a day and Team
 * is opened twice a year. The groups do not add a level of hierarchy — nothing
 * collapses, everything stays one click away — they just let the eye skip two
 * thirds of the list.
 *
 * The rail is dark on every authenticated screen (a decision, not a Home
 * treatment), so colours here are the fixed on-ink set rather than the
 * `--sidebar-*` aliases: this component always knows it is on ink.
 */
/**
 * Three groups, and the names are the owner's rather than ours (W3.1).
 *
 * Fifteen items is not a menu, it is an inventory, and most of them were named
 * for the thing we built rather than the job somebody came to do: "Inbox",
 * "Digest", "Showcase", "Broadcasts". The audit's complaint was that a café
 * owner cannot tell from the rail where anything is.
 *
 * The three groups answer three different questions:
 *
 *   - **WORK** — what is waiting for me today.
 *   - **GROW** — what I do to get more of it.
 *   - **SETUP** — things I configure once and rarely revisit.
 *
 * Two items left the rail entirely and became tabs, because they are the *same
 * errand* as their neighbour seen from a different angle: campaigns are how you
 * reach the people in Contacts, and surveys are another way of asking what Get
 * reviews asks. A rail entry for each made them look like separate departments.
 *
 * **Two deviations from `docs/remediation-plan.md`, both deliberate:**
 *
 *   1. The plan says "9-item rail" and then lists eleven. The list is the
 *      intent; eleven it is. Thirteen with Channels, which W2.2 added after the
 *      plan was written, and Agency, which only an agency sees.
 *   2. The plan folds Connections into "Locations & Connections". Connections
 *      does not exist as a screen yet — W4.2 builds it — so the entry stays
 *      "Locations", which is what it currently opens. Naming it for a screen
 *      that is not there would be the exact fault this task is fixing.
 */
const GROUPS = [
  {
    label: "groupWork",
    // Notifications used to sit here. It moved to the top bar: it is a *state*
    // of the account rather than a place in the product, and an unread count
    // belongs where the eye already goes for account things — beside the avatar,
    // visible on every screen including a phone, where this rail is not.
    items: [
      { href: "/dashboard", key: "home", Icon: Home },
      // "Reviews", not "Inbox". An inbox is a mail metaphor; what is in here is
      // reviews, and the word somebody searches the rail for is the noun.
      { href: "/reviews", key: "inbox", Icon: Inbox },
      { href: "/conversations", key: "messages", Icon: MessageSquare },
      // "Weekly plan", not "Digest". A digest is a thing we compose; a plan is
      // the thing they act on, and it is the product's whole claim.
      { href: "/weekly-plan", key: "digest", Icon: CalendarRange },
    ],
  },
  {
    label: "groupGrow",
    items: [
      { href: "/get-reviews", key: "requests", Icon: Send },
      { href: "/contacts", key: "contacts", Icon: Contact },
      { href: "/widgets", key: "widgets", Icon: LayoutGrid },
      { href: "/analytics", key: "insights", Icon: LineChart },
    ],
  },
  {
    label: "groupSetup",
    items: [
      { href: "/locations", key: "locations", Icon: MapPin },
      // Channels is Setup, not Growth: connecting WhatsApp is something you do
      // once, and it belongs beside the other things you configure and forget.
      { href: "/channels", key: "channels", Icon: Radio },
      { href: "/team", key: "team", Icon: Users },
      { href: "/settings", key: "settings", Icon: Settings },
      // Only meaningful for an agency, and harmless otherwise: the console's
      // empty state explains what a client is and how to link one.
      { href: "/agency", key: "clients", Icon: Building2 },
    ],
  },
] as const;

export function SidebarNav() {
  const t = useTranslations("nav");
  const pathname = usePathname();

  return (
    <nav aria-label={t("home")} className="flex flex-col px-3">
      {GROUPS.map((group) => (
        <div key={group.label} className="contents">
          <span
            // Presentational: the accessible grouping comes from the list
            // structure, and repeating "Daily" before each link would be noise.
            aria-hidden
            className="px-[11px] pt-3.5 pb-1.5 text-[10px] font-semibold tracking-[0.1em] text-white/55 uppercase"
          >
            {t(group.label)}
          </span>

          {group.items.map(({ href, key, Icon }) => {
            /**
             * A tabbed screen keeps its parent lit (W3.1).
             *
             * `/surveys` and `/campaigns` have no rail entry of their own, so
             * without this the rail highlighted nothing the moment somebody
             * opened a tab — the navigation telling the reader they were
             * nowhere. `railParentFor` is the single definition of which
             * screens belong together; the tab strip reads the same one.
             */
            const active =
              pathname === href ||
              pathname.startsWith(`${href}/`) ||
              railParentFor(pathname) === href;

            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-[11px] rounded-md px-[11px] py-[9px] text-copy transition-colors",
                  "focus-visible:ring-3 focus-visible:ring-sidebar-ring/50 focus-visible:outline-none",
                  active
                    ? "bg-primary font-semibold text-white"
                    : "font-medium text-white/62 hover:bg-white/8 hover:text-white",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {t(key)}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
