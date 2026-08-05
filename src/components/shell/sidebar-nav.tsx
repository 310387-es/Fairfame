"use client";

import {
  Building2,
  CalendarRange,
  ClipboardList,
  Contact,
  Home,
  Inbox,
  LayoutGrid,
  LineChart,
  MapPin,
  Megaphone,
  MessageSquare,
  Send,
  Settings,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
const GROUPS = [
  {
    label: "groupDaily",
    // Notifications used to sit here. It moved to the top bar: it is a *state*
    // of the account rather than a place in the product, and an unread count
    // belongs where the eye already goes for account things — beside the avatar,
    // visible on every screen including a phone, where this rail is not.
    items: [
      { href: "/home", key: "home", Icon: Home },
      { href: "/inbox", key: "inbox", Icon: Inbox },
      // Weekly rather than daily, so it sits below the two screens that are
      // opened every day — but still in this group, because the digest is what
      // the daily work is meant to add up to.
      { href: "/digest", key: "digest", Icon: CalendarRange },
      // Insights sits in Daily rather than Growth: "are we improving" is a
      // question about the work already being done, not a channel for more of
      // it — and it is read beside Home and the Digest, not beside Requests.
      { href: "/insights", key: "insights", Icon: LineChart },
    ],
  },
  {
    label: "groupGrowth",
    items: [
      { href: "/requests", key: "requests", Icon: Send },
      // Contacts sits in Growth, next to Requests: the two are the same loop
      // seen from either end — who we asked, and who they turned out to be.
      // It is not an Account screen; a customer file is worked, not configured.
      { href: "/contacts", key: "contacts", Icon: Contact },
      // Surveys sit beside Requests and Contacts for the same reason: all three
      // are ways of asking a customer something and doing something with the
      // answer. A survey is not analytics — the score turns up on Insights, but
      // the asking happens here.
      { href: "/surveys", key: "surveys", Icon: ClipboardList },
      // Conversations, not a second Inbox. The Inbox above triages *reviews* —
      // items that arrive once and must be dealt with. This is people, and the
      // two behave differently enough that merging them would give one of them
      // the other's controls.
      { href: "/messages", key: "messages", Icon: MessageSquare },
      // Broadcasts last in Growth: it is the thing you reach for once the
      // contacts, the surveys and the conversations already exist.
      { href: "/broadcasts", key: "broadcasts", Icon: Megaphone },
      // Showcase sits in Growth rather than Account: a widget is how reviews
      // are turned into something that brings people in, which is the same job
      // review requests do from the other end.
      { href: "/widgets", key: "widgets", Icon: LayoutGrid },
      { href: "/locations", key: "locations", Icon: MapPin },
    ],
  },
  {
    label: "groupAccount",
    items: [
      // Only meaningful for an agency, and harmless otherwise: the console's
      // empty state explains what a client is and how to link one.
      { href: "/clients", key: "clients", Icon: Building2 },
      { href: "/team", key: "team", Icon: Users },
      { href: "/settings", key: "settings", Icon: Settings },
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
            const active = pathname === href || pathname.startsWith(`${href}/`);

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
