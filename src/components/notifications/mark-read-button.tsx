"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { markNotificationsReadAction } from "@/server/notifications";

/**
 * Marks one notification read.
 *
 * The action revalidates the layout, so the row restyles and the sidebar badge
 * drops together — one round trip rather than optimistic state that has to be
 * reconciled if the write fails.
 */
export function MarkReadButton({ id, label }: { id: string; label: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-auto px-2 py-1 text-xs"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await markNotificationsReadAction({ ids: [id] });
        });
      }}
    >
      {label}
    </Button>
  );
}
