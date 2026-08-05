"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { CardLink } from "@/components/ds/section-card";
import { Badge } from "@/components/ui/badge";

/**
 * One widget in the list.
 *
 * The badge carries the only fact that matters at a glance, and it says it in
 * words rather than in colour alone — "Live" and "Draft" are the difference
 * between something on the open internet and something that is not, which is
 * not a distinction to leave to a green dot.
 */
export function WidgetRow({
  widget,
  canManage,
}: {
  widget: {
    id: string;
    name: string;
    published: boolean;
    layout: string;
    locationName: string | null;
  };
  canManage: boolean;
}) {
  const t = useTranslations("widgets");

  return (
    <li className="flex items-center gap-3 border-b border-line-soft px-(--card-px) py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-body font-semibold">{widget.name}</p>
        <p className="text-meta text-faint">
          {widget.locationName ?? t("allLocations")}
          <span aria-hidden> · </span>
          {t(`layout.${widget.layout}`)}
        </p>
      </div>

      <Badge variant={widget.published ? "positive" : "count"} className="ml-auto shrink-0">
        {widget.published ? t("live") : t("draft")}
      </Badge>

      <Link
        href={`/widgets/${widget.id}`}
        className="shrink-0 rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <CardLink>{canManage ? t("edit") : t("view")}</CardLink>
      </Link>
    </li>
  );
}
