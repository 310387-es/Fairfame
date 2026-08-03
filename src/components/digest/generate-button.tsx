"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { generateDigestAction } from "@/server/digests";

/**
 * "Generate now".
 *
 * Composing takes the better part of a minute and runs in the worker, so the
 * button reports that the work was *queued* rather than pretending to wait.
 * A spinner that resolves into the same stale page would be worse than saying
 * plainly that it is being written.
 */
export function GenerateDigestButton({
  locationId,
  label,
  queuedLabel,
}: {
  locationId: string;
  label: string;
  queuedLabel: string;
}) {
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (queued) {
    return <p className="text-xs text-muted-foreground">{queuedLabel}</p>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await generateDigestAction({ locationId });
            if (result.ok) setQueued(true);
            else setError(result.error);
          });
        }}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Sparkles className="size-4" aria-hidden />
        )}
        {label}
      </Button>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
