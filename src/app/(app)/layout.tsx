import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  NoActiveOrganizationError,
  requireActor,
  UnauthenticatedError,
} from "@/auth/session";
import { Logo } from "@/components/brand/logo";
import { LocaleSwitcher } from "@/components/shell/locale-switcher";
import { LocationSwitcher } from "@/components/shell/location-switcher";
import { MobileNav } from "@/components/shell/mobile-nav";
import { NotificationBell } from "@/components/shell/notification-bell";
import { SearchPalette } from "@/components/shell/search-palette";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import { TrialFooter } from "@/components/shell/trial-footer";
import { UserMenu } from "@/components/shell/user-menu";
import { listOrganizationsForUser } from "@/agency/clients";
import { getLocale } from "@/i18n/locale";
import {
  listLocationsForActor,
  readActiveLocationCookie,
  resolveActiveLocation,
} from "@/lib/active-location";
import { getEntitlements } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";
import { unreadCounts } from "@/notifications/feed";

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

  const locale = await getLocale();

  // Outside the tenant transaction on purpose: this is the *user's* own
  // membership list, not tenant data, and scoping it to the organization they
  // happen to be in would return exactly one row — the one they are already on.
  const organizations = await listOrganizationsForUser(actor.userId);

  const { locations, entitlements, unread } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => ({
      // The switcher offers only the branches this person may open.
      locations: await listLocationsForActor(tx, actor),
      entitlements: await getEntitlements({ organizationId: actor.organizationId, tx }),
      // Per user, not per organization — the badge is this person's unread
      // count, and the query filters on the actor for exactly that reason.
      unread: await unreadCounts(tx, actor.organizationId, actor.userId),
    }),
  );

  const activeLocation = resolveActiveLocation(locations, await readActiveLocationCookie());

  return (
    <div className="flex min-h-screen flex-1">
      {/* The rail is ink on every authenticated screen. Full-bleed colour
          appears exactly twice in this product — here and on the briefing bar —
          and that scarcity is what lets the rail anchor the page without
          competing with the data beside it. */}
      {/* Sticky and exactly one viewport tall, with its own scroll.
          It used to be as tall as the *page*, so on a long screen the whole rail
          travelled up with the content — scroll far enough and you were looking
          at empty ink with the navigation somewhere above you. Navigation should
          not be something you scroll back to find.

          `h-screen` rather than `h-full`: sticky positions against the viewport,
          so the rail has to be measured in viewport units too. `overflow-y-auto`
          is the release valve for a short window — with many nav groups the
          trial footer would otherwise be pushed out of reach. */}
      <aside className="sticky top-0 hidden h-screen w-(--rail-width) shrink-0 flex-col overflow-y-auto bg-rail text-on-ink md:flex">
        <Link
          href="/home"
          className="flex h-(--topbar-height) shrink-0 items-center gap-2.5 px-[18px] text-base font-semibold tracking-[-0.01em]"
        >
          <Logo className="text-white" markClassName="size-[26px]" />
        </Link>

        <SidebarNav />

        <TrialFooter
          isTrialing={entitlements.isTrialing}
          trialEndsAt={entitlements.trialEndsAt}
          planKey={entitlements.effectivePlanKey}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-canvas">
        {/* White, hairline, no blur. Nothing in this system is glassy — a
            translucent bar over a scrolling chart is legibility spent on an
            effect nobody asked for. */}
        <header className="sticky top-0 z-10 flex h-(--topbar-height) items-center gap-3.5 border-b border-line bg-surface px-4 md:px-(--page-gutter)">
          {/* The rail above is desktop-only, so on a phone this is the *only*
              way to reach anything but Home. It carries the same nav, not a
              reduced one. `TrialFooter` is server-rendered here and handed
              across as children — see `mobile-nav.tsx`. */}
          <MobileNav
            footer={
              <TrialFooter
                isTrialing={entitlements.isTrialing}
                trialEndsAt={entitlements.trialEndsAt}
                planKey={entitlements.effectivePlanKey}
              />
            }
          />

          <LocationSwitcher locations={locations} activeId={activeLocation?.id ?? null} />

          <SearchPalette />

          <div className="ml-auto flex items-center gap-1">
            <NotificationBell unread={unread.total} urgent={unread.urgent > 0} />
            <LocaleSwitcher locale={locale} />
            <UserMenu
              name={session?.user.name ?? ""}
              email={session?.user.email ?? ""}
              role={actor.role}
              organizations={organizations.map(({ id, name }) => ({ id, name }))}
              activeOrganizationId={actor.organizationId}
            />
          </div>
        </header>

        {/* Every page is a flex column on the canvas with the system's 14px
            block gap. Pages therefore never set their own outer spacing, and
            two pages cannot drift apart on it. */}
        <main className="mx-auto flex w-full max-w-(--content-max) flex-1 flex-col gap-(--grid-gap) px-4 py-[22px] md:px-(--page-gutter)">
          {children}
        </main>
      </div>
    </div>
  );
}
