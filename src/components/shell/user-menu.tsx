"use client";

import { Building2, Check, LogOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { signOut } from "@/auth/client";
import { switchOrganizationAction } from "@/server/agency";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The account menu, and — since P4-T5 — the organization switcher.
 *
 * **It exists because the agency console was one-way.** "Open" on `/clients`
 * switched an agency into a client and nothing switched back, so somebody
 * belonging to several organizations could reach a client and be stuck in it.
 * That was invisible while every account had exactly one organization.
 *
 * The list is only rendered when there is more than one, so a single-org
 * account sees no new chrome at all. Switching goes through
 * `switchOrganizationAction`, which delegates the membership check to
 * BetterAuth — the one check standing between this menu and "set my tenant
 * context to any id".
 */
export function UserMenu({
  name,
  email,
  role,
  organizations,
  activeOrganizationId,
}: {
  name: string;
  email: string;
  role: string;
  organizations: { id: string; name: string }[];
  activeOrganizationId: string;
}) {
  const t = useTranslations("nav");
  const tTeam = useTranslations("team.roles");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const initials =
    name
      .split(" ")
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2" disabled={pending}>
          <span className="grid size-6 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
            {initials}
          </span>
          <span className="hidden max-w-[14ch] truncate sm:inline">{name}</span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate font-medium">{name}</span>
          <span className="block truncate text-copy text-muted-foreground">{email}</span>
          <span className="mt-1 block text-copy text-muted-foreground">
            {tTeam(role as "owner" | "admin" | "member" | "client")}
          </span>
        </DropdownMenuLabel>
        {organizations.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-copy font-normal text-muted-foreground">
              {t("organizations")}
            </DropdownMenuLabel>

            {organizations.map((organization) => {
              const active = organization.id === activeOrganizationId;

              return (
                <DropdownMenuItem
                  key={organization.id}
                  disabled={pending || active}
                  onSelect={() => {
                    startTransition(async () => {
                      const result = await switchOrganizationAction({
                        organizationId: organization.id,
                      });
                      // Home rather than staying put: the current page may not
                      // exist on the other organization's plan, and landing on
                      // a locked card after a switch reads as a broken switch.
                      if (result.ok) {
                        router.push("/home");
                        router.refresh();
                      }
                    });
                  }}
                >
                  {active ? (
                    <Check className="size-4" aria-hidden />
                  ) : (
                    <Building2 className="size-4" aria-hidden />
                  )}
                  <span className="truncate">{organization.name}</span>
                </DropdownMenuItem>
              );
            })}
          </>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            startTransition(async () => {
              await signOut();
              router.push("/sign-in");
              router.refresh();
            });
          }}
        >
          <LogOut className="size-4" aria-hidden />
          {t("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
