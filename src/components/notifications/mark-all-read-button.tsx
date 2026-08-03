"use client";

import { CheckCheck } from "lucide-react";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { markAllNotificationsReadAction } from "@/server/notifications";

export function MarkAllReadButton({ label, disabled }: { label: string; disabled: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled || pending}
      onClick={() => {
        startTransition(async () => {
          await markAllNotificationsReadAction();
        });
      }}
    >
      <CheckCheck className="size-4" aria-hidden />
      {label}
    </Button>
  );
}
