"use client";

import { Building2, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAction } from "@/components/ui/use-action";
import { switchOrganizationAction } from "@/server/agency";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The organizations this person already belongs to (W1.1).
 *
 * **Why this screen exists at all.** `/create-organization` used to be a bare
 * create form, and a session with no active organization was sent to it — so
 * somebody who already had a workspace was shown a form asking them to make
 * another. That is how a customer ends up with two organizations and their data
 * in the one they are not looking at.
 *
 * With the session hook in place this is now a rare screen: it is reached by
 * somebody who belongs to several organizations and has never chosen one, or
 * whose remembered choice is no longer theirs. Creating is still offered — it
 * is just no longer the only thing offered.
 *
 * Switching goes through `switchOrganizationAction`, the same action the user
 * menu and the agency console use, which delegates the membership check to
 * BetterAuth. This component never sees a tenant id it did not get from the
 * server's own membership list.
 */
export function OrganizationPicker({
  organizations,
}: {
  organizations: { id: string; name: string }[];
}) {
  const t = useTranslations("auth");
  const router = useRouter();

  const { run, pending } = useAction();

  return (
    <Card>
      <div className="px-(--card-px)">
        <h1 className="text-display text-balance">{t("chooseOrgTitle")}</h1>
        {/*
          Counted, because this screen is reachable with exactly one workspace
          and the sentence used to claim otherwise.

          `create-organization/page.tsx` shows the picker whenever the person
          belongs to *any* organization — which includes one, the state the app
          shell redirects into when a session has no active organization. It
          said "You belong to more than one workspace" over a list of one, which
          is a screen telling a customer something demonstrably untrue about
          their own account. `docs/15` §7: honesty is the house style, and it
          applies to a subtitle as much as to a metric.
        */}
        <p className="mt-1 text-body text-pretty text-ink-400">
          {t("chooseOrgSubtitle", { count: organizations.length })}
        </p>
      </div>

      <CardContent className="space-y-2">
        {organizations.map((organization) => (
          <Button
            key={organization.id}
            variant="outline"
            className="w-full justify-start gap-2"
            disabled={pending}
            onClick={() => {
              run(() => switchOrganizationAction({ organizationId: organization.id }), {
                onSuccess: () => {
                  router.push("/dashboard");
                  router.refresh();
                },
              });
            }}
          >
            <Building2 className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{organization.name}</span>
          </Button>
        ))}

        {/* A link rather than a second form: creating another organization is
            the rarer intent on this screen, and putting it behind one click
            keeps it available without making it the default again. */}
        <p className="pt-2 text-center text-copy text-ink-400">
          <Link
            href="/create-organization?new=1"
            className="inline-flex items-center gap-1 rounded-sm font-medium text-ink-600 underline underline-offset-2 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <Plus className="size-3.5" aria-hidden />
            {t("createOrgInstead")}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
