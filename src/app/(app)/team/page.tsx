import { getTranslations } from "next-intl/server";
import { roleAtLeast } from "@/auth/permissions";
import { listTeamWithScope } from "@/auth/scope";
import { requireActor } from "@/auth/session";
import { InviteForm } from "@/components/team/invite-form";
import { MemberScope } from "@/components/team/member-scope";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { and, eq } from "drizzle-orm";
import { getAdminDb, schema } from "@/db/client";
import { listLocations } from "@/lib/active-location";
import { withinLimit } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";

/**
 * Team.
 *
 * Invitations (W1.9) and location scope. Role *changes* are still absent —
 * moving somebody between admin and member is a different act from adding them,
 * and nothing in the audit asked for it.
 *
 * Until W1.9 the product could not make a second user at all: this screen set
 * scope for members who could only be created from a database console, which
 * left the assignee dropdown on every review card permanently "Unassigned" and
 * the whole of P2's team workflow unreachable by an actual team.
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

  const { members, locations, seats } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => ({
      members: await listTeamWithScope(tx, actor.organizationId),
      locations: await listLocations(tx, actor.organizationId),
      seats: await withinLimit({ organizationId: actor.organizationId, tx }, "max_team_members"),
    }),
  );

  const canManage = roleAtLeast(actor.role, "admin");

  /**
   * Invitations that have been sent and not answered.
   *
   * `adminDb`, because `invitations` has no RLS policy of its own — it is
   * BetterAuth's table and the plugin reads it on the owner connection. The
   * organization filter is therefore doing real work here rather than being
   * belt-and-braces, and it comes from `requireActor`, never from input.
   */
  const invitations = canManage
    ? await getAdminDb()
        .select({
          id: schema.invitations.id,
          email: schema.invitations.email,
          role: schema.invitations.role,
          expiresAt: schema.invitations.expiresAt,
        })
        .from(schema.invitations)
        .where(
          and(
            eq(schema.invitations.organizationId, actor.organizationId),
            eq(schema.invitations.status, "pending"),
          ),
        )
        .orderBy(schema.invitations.email)
    : [];

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("inviteSectionTitle")}</CardTitle>
            <CardDescription>{t("inviteSectionSubtitle")}</CardDescription>
          </CardHeader>
          <CardContent>
            <InviteForm
              pending={invitations.map((row) => ({
                id: row.id,
                email: row.email,
                role: row.role,
                expiresAt: row.expiresAt.toISOString(),
              }))}
              roleLabels={{
                admin: tRoles("admin"),
                member: tRoles("member"),
                client: tRoles("client"),
              }}
              // A spent seat allowance is a sentence, not a disabled form.
              // Pending invitations count: they are seats already promised.
              atLimit={seats.allowed ? null : t("seatsSpent", { limit: seats.limit ?? 0 })}
            />
          </CardContent>
        </Card>
      ) : null}

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
    </>
  );
}
