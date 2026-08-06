import { getTranslations } from "next-intl/server";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { channelStatuses } from "@/channels/status";
import { ChannelCard } from "@/components/channels/channel-card";
import { PageHeader } from "@/components/shell/page-header";
import { withTenant } from "@/lib/tenancy";

/**
 * Channels — where you message a customer (W2.2).
 *
 * The home W1.4 promised WhatsApp when it stopped offering it on the Locations
 * screen. A channel is not a review source: it is not polled, it has no sync
 * cursor, it belongs to the organization rather than to a branch, and the
 * question it has to answer is not "what did it bring in" but "may this carry a
 * message right now".
 *
 * **Every channel here is mock-only, and the page says so on each card rather
 * than once at the top.** A banner is read once and then stops being read; the
 * blocker list is attached to the thing it is about, so a business cannot come
 * away thinking one of them is live.
 */
export default async function ChannelsPage() {
  const [actor, t] = await Promise.all([requireActor(), getTranslations("channels")]);

  const statuses = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    (tx) => channelStatuses(tx, actor.organizationId),
  );

  // Connecting a channel grants standing permission to send as the business —
  // a stronger grant than a review source, which only reads.
  const canManage = roleAtLeast(actor.role, "admin");

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="grid gap-(--grid-gap) md:grid-cols-2">
        {statuses.map((status) => (
          <ChannelCard
            key={status.descriptor.key}
            channel={status.descriptor.key}
            label={status.descriptor.label}
            provisioning={status.descriptor.provisioning}
            mode={status.mode}
            blockers={status.blockers}
            connectionStatus={status.connection?.status ?? null}
            displayName={status.connection?.displayName ?? null}
            lastError={status.connection?.lastError ?? null}
            envVar={status.descriptor.envVar}
            canManage={canManage}
          />
        ))}
      </div>
    </>
  );
}
