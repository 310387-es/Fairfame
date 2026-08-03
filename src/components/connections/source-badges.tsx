import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import type { ReplyAffordance, SyncKind } from "@/connectors/capability-view";

/**
 * The honest label set for a source.
 *
 * Every badge here is read off declared capabilities rather than a provider
 * name, so a source that can only show truncated text says *Monitor only*, and
 * one running on seeded data says so plainly. `docs/06-ux-roles-and-flows.md`
 * asks the connect flow to show capability and approval status honestly —
 * quietly presenting sample data as a live Google feed would be the single
 * easiest way to lose a design partner's trust.
 */

export type SourceBadgesProps = {
  sync: SyncKind;
  reply: ReplyAffordance;
  isMock: boolean;
  status?: "pending" | "active" | "error" | "disconnected";
};

export function SourceBadges({ sync, reply, isMock, status }: SourceBadgesProps) {
  const t = useTranslations("sources");

  const syncLabel = { live: t("liveSync"), monitor: t("monitorOnly"), outbound: t("outboundOnly") }[
    sync
  ];

  const replyLabel = {
    compose: t("replyInApp"),
    open_on_platform: t("replyOnPlatform"),
    none: null,
  }[reply];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* "Live" is a reading about the connection, not something to click. */}
      <Badge variant={sync === "live" ? "positive" : "secondary"}>{syncLabel}</Badge>
      {replyLabel ? <Badge variant="outline">{replyLabel}</Badge> : null}
      {isMock ? <Badge variant="secondary">{t("sampleData")}</Badge> : null}
      {status === "error" ? <Badge variant="destructive">{t("needsAttention")}</Badge> : null}
      {status === "pending" ? <Badge variant="outline">{t("pending")}</Badge> : null}
    </div>
  );
}
