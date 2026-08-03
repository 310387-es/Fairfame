import { getTranslations } from "next-intl/server";
import { requireActor } from "@/auth/session";
import { MarkAllReadButton } from "@/components/notifications/mark-all-read-button";
import { NotificationList } from "@/components/notifications/notification-list";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { withTenant } from "@/lib/tenancy";
import { listFeed, unreadCounts } from "@/notifications/feed";

/**
 * The in-app notification feed.
 *
 * Read and unread are shown together rather than as separate tabs: the point
 * of the page is "what happened at my locations", and hiding what you have
 * already seen makes the list jump around as you read it.
 */
export default async function NotificationsPage() {
  const [t, actor] = await Promise.all([getTranslations("notifications"), requireActor()]);

  const { items, counts } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => ({
      // Both scoped to the signed-in user, not to the organization: RLS keeps
      // tenants apart and nothing else, so the user filter is the whole
      // protection against reading a colleague's feed.
      items: await listFeed(tx, actor.organizationId, actor.userId, { limit: 50 }),
      counts: await unreadCounts(tx, actor.organizationId, actor.userId),
    }),
  );

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={<MarkAllReadButton label={t("markAllRead")} disabled={counts.total === 0} />}
      />

      <div className="mb-4 flex items-center gap-2">
        <Badge variant={counts.urgent > 0 ? "destructive" : "secondary"}>
          {t("unread", { count: counts.total })}
        </Badge>
      </div>

      <NotificationList items={items} />
    </>
  );
}
