"use client";

import { Bell, Home, Inbox, MapPin, Send, Settings, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Left-rail navigation. Phase 0 ships the routes; most are placeholders. */
const ITEMS = [
  { href: "/home", key: "home", Icon: Home },
  { href: "/inbox", key: "inbox", Icon: Inbox },
  { href: "/notifications", key: "notifications", Icon: Bell },
  { href: "/requests", key: "requests", Icon: Send },
  { href: "/locations", key: "locations", Icon: MapPin },
  { href: "/team", key: "team", Icon: Users },
  { href: "/settings", key: "settings", Icon: Settings },
] as const;

export type SidebarNavProps = {
  /** Unread notifications for the signed-in user, resolved in the layout. */
  unread?: number;
  /** True when any unread notification is urgent — the badge turns red. */
  urgent?: boolean;
};

export function SidebarNav({ unread = 0, urgent = false }: SidebarNavProps) {
  const t = useTranslations("nav");
  const pathname = usePathname();

  return (
    <nav aria-label={t("home")} className="flex flex-col gap-1 p-3">
      {ITEMS.map(({ href, key, Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);

        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              "focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none",
              active
                ? "bg-sidebar-primary text-sidebar-primary-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {t(key)}

            {key === "notifications" && unread > 0 ? (
              <span
                // A count, not a dot: "you have unread notifications" is much
                // less actionable than "you have three".
                aria-label={t("unreadBadge", { count: unread })}
                className={cn(
                  "ml-auto rounded-full px-1.5 py-0.5 text-[11px] leading-none font-semibold tabular-nums",
                  urgent
                    ? "bg-destructive text-white"
                    : "bg-sidebar-accent text-sidebar-accent-foreground",
                )}
              >
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
