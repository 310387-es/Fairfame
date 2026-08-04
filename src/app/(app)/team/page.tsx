import { getTranslations } from "next-intl/server";
import { roleAtLeast } from "@/auth/permissions";
import { listTeamWithScope } from "@/auth/scope";
import { requireActor } from "@/auth/session";
import { MemberScope } from "@/components/team/member-scope";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listLocations } from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";

/**
 * Team.
 *
 * Location scope only — not invitations or role changes, which belong to the
 * BetterAuth organization plugin and a later phase. This exists because
 * `member_locations` shipped with P2-T4 enforcing a rule the product had no way
 * to *set*: a member's branches could only be pinned from a database console.
 *
 * The location list here is deliberately the **unscoped** reader. Every other
 * screen asks what the signed-in person may see; this one is about assigning
 * that, so an admin has to be able to see the branches they are assigning —
 * including any they are not themselves pinned to.
 */
export default async function TeamPage() {
  const [t, tRoles, actor] = await Promise.all([
    getTranslations("team"),
    getTranslations("team.roles"),
    requireActor(),
  ]);

  const { members, locations } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => ({
      members: await listTeamWithScope(tx, actor.organizationId),
      locations: await listLocations(tx, actor.organizationId),
    }),
  );

  const canManage = roleAtLeast(actor.role, "admin");

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Card>
        <CardHeader>
          <CardTitle>{t("scopeTitle")}</CardTitle>
          <CardDescription>{t("scopeSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {locations.length === 0 ? (
            <p className="text-body text-muted-foreground">{t("noLocations")}</p>
          ) : (
            members.map((member) => (
              <MemberScope
                key={member.userId}
                member={member}
                locations={locations}
                // The server enforces admin too; this only decides whether to
                // render controls that would be refused.
                canManage={canManage}
                roleLabel={tRoles(member.role)}
              />
            ))
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardContent className="py-10 text-center text-body text-muted-foreground">
          {t("placeholder")}
        </CardContent>
      </Card>
    </>
  );
}
