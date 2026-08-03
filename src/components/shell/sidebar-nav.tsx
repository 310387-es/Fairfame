"use client";

import { CalendarRange, Home, Inbox, MapPin, Send, Settings, Users } from "lucide-react";
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
    ],
  },
  {
    label: "groupGrowth",
    items: [
      { href: "/requests", key: "requests", Icon: Send },
      { href: "/locations", key: "locations", Icon: MapPin },
    ],
  },
  {
    label: "groupAccount",
    items: [
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
