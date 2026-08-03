import type { ComponentType, ReactNode } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The frame the six lower widgets share.
 *
 * They differ in what they draw and agree on everything around it — icon,
 * title, an optional link out. Six copies of this header would drift apart
 * within a month, and the row only reads as a row because the frames match.
 */
export function WidgetCard({
  title,
  icon: Icon,
  link,
  children,
}: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  link?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <Card className="rounded-2xl">
      {/* `flex-1` so content can centre in a card that was stretched to match
          its taller neighbours in the grid row, instead of hugging the top and
          leaving a hole underneath. */}
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="grid size-6.5 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Icon className="size-3.5" />
          </span>
          <h2 className="text-sm font-semibold">{title}</h2>
          {link ? (
            <Link
              href={link.href}
              className="ml-auto rounded text-xs font-semibold text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {link.label}
            </Link>
          ) : null}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}
