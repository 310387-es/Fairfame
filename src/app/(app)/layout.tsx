import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  NoActiveOrganizationError,
  requireActor,
  UnauthenticatedError,
} from "@/auth/session";
import { LocaleSwitcher } from "@/components/shell/locale-switcher";
import { LocationSwitcher } from "@/components/shell/location-switcher";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import { UserMenu } from "@/components/shell/user-menu";
import { Badge } from "@/components/ui/badge";
import { getLocale } from "@/i18n/locale";
import {
  listLocations,
  readActiveLocationCookie,
  resolveActiveLocation,
} from "@/lib/active-location";
import { getEntitlements } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";

/**
 * The authenticated application shell.
 *
 * Every route beneath this layout is gated here: no session redirects to
 * sign-in, and a session without an organization redirects to organization
 * creation. Pages inside can therefore assume an actor exists.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  let actor;
  try {
    actor = await requireActor();
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/sign-in");
    if (error instanceof NoActiveOrganizationError) redirect("/create-organization");
    throw error;
  }

  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);

  const { locations, entitlements } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => ({
      locations: await listLocations(tx, actor.organizationId),
      entitlements: await getEntitlements({ organizationId: actor.organizationId, tx }),
    }),
  );

  const activeLocation = resolveActiveLocation(locations, await readActiveLocationCookie());

  return (
    <div className="flex min-h-screen flex-1">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <Link
          href="/home"
          className="flex h-14 items-center gap-2 border-b border-sidebar-border px-5"
        >
          <span className="size-5 rounded-[6px] bg-primary" aria-hidden />
          <span className="text-base font-semibold tracking-tight text-sidebar-foreground">
            {t("app.name")}
          </span>
        </Link>

        <SidebarNav />

        <div className="mt-auto p-3">
          <Badge variant="secondary" className="w-full justify-center">
            {entitlements.isTrialing
              ? t("shell.trialBadge", { days: daysUntil(entitlements.trialEndsAt) })
              : t("shell.planBadge", { plan: entitlements.effectivePlanKey })}
          </Badge>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75 md:px-6">
          <LocationSwitcher locations={locations} activeId={activeLocation?.id ?? null} />

          <div className="ml-auto flex items-center gap-1">
            <LocaleSwitcher locale={locale} />
            <UserMenu
              name={session?.user.name ?? ""}
              email={session?.user.email ?? ""}
              role={actor.role}
            />
          </div>
        </header>

        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}

/**
 * Whole days remaining, rounded up so the last partial day still reads as "1"
 * rather than "0 days left" while the trial is genuinely still active.
 */
function daysUntil(date: Date | null): number {
  if (!date) return 0;
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000));
}
