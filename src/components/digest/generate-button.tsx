"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/ui/use-action";
import { digestProgressAction, generateDigestAction } from "@/server/digests";

/**
 * The Home screen's compose control.
 *
 * Composing takes the better part of a minute and runs in the worker, so the
 * click queues a job rather than waiting on one. What it must not do is queue
 * the job and then go quiet: Home renders the newest *ready* digest, and a
 * regeneration moves the target week back to `pending`, so for that minute the
 * screen shows the previous plan with nothing to say a new one is coming.
 * "Refresh shortly" put the burden of knowing when onto the reader.
 *
 * So it watches, and refreshes the page itself the moment the digest lands.
 * Polling rather than pushing because a worker in another process has no socket
 * to this page, and one indexed row every few seconds — for one admin who just
 * pressed a button — is cheaper than the infrastructure that would avoid it.
 */

/** Gap between checks. Composing takes ~40-60s, so this is ~15-20 of them. */
const POLL_INTERVAL_MS = 3_000;

/**
 * When to stop watching.
 *
 * Generous, because the opposite mistake is worse: give up while the job is
 * still running and someone is left with a stale page they believe is finished.
 * The queue's own retries are bounded well inside this.
 */
const POLL_TIMEOUT_MS = 240_000;

type Phase = "idle" | "composing" | "slow" | "failed";

export function GenerateDigestButton({
  locationId,
  label,
  composingLabel,
  slowLabel,
  failedLabel,
}: {
  locationId: string;
  /** Names the week this composes — `home.generate` / `home.regenerate`. */
  label: string;
  composingLabel: string;
  slowLabel: string;
  failedLabel: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const { run, pending } = useAction();

  // Read by the loop on every pass, so a poll cannot outlive the component and
  // refresh a page the reader has already navigated away from.
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
    };
  }, []);

  const watch = useCallback(async () => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (!stopped.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (stopped.current) return;

      const progress = await digestProgressAction({ locationId });

      // A failed *check* is not a failed digest — the job is probably fine, and
      // reporting a failure that did not happen is the worse error.
      if (!progress.ok) continue;

      if (progress.status === "ready") {
        setPhase("idle");
        // The digest is a server-rendered read, so re-fetching the tree is what
        // puts it on screen — and it arrives without losing scroll position.
        router.refresh();
        return;
      }

      if (progress.status === "failed") {
        setPhase("failed");
        return;
      }
    }

    // Out of patience, not out of hope: the hourly sweep still finishes the
    // job. So this says "taking longer than expected", never "broken".
    if (!stopped.current) setPhase("slow");
  }, [locationId, router]);

  if (phase === "composing") {
    return (
      <p className="flex items-center gap-2 text-copy text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {composingLabel}
      </p>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => {
          run(() => generateDigestAction({ locationId }), {
            onSuccess: () => {
              setPhase("composing");
              void watch();
            },
            onError: () => setPhase("idle"),
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

      {phase === "slow" ? <p className="text-copy text-muted-foreground">{slowLabel}</p> : null}
      {phase === "failed" ? <p className="text-copy text-destructive">{failedLabel}</p> : null}
    </div>
  );
}
