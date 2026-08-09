"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/ui/use-action";
import { digestProgressAction, generateDigestAction } from "@/server/digests";

/**
 * The weekly plan's compose control.
 *
 * Composing takes the better part of a minute and runs in the worker, so the
 * click queues a job rather than waiting on one. What it must not do is queue
 * the job and then go quiet: the screen renders the newest *ready* digest, so
 * for that minute there is nothing to say a new one is coming. "Refresh
 * shortly" put the burden of knowing when onto the reader.
 *
 * So it watches, and refreshes the page itself the moment the digest lands.
 * Polling rather than pushing because a worker in another process has no socket
 * to this page, and one indexed row every few seconds — for one admin who just
 * pressed a button — is cheaper than the infrastructure that would avoid it.
 *
 * **What it watches changed with A22-A1.** A refresh no longer moves the row
 * off `ready` — that was the bug: a failed refresh took the owner's briefing off
 * the screen. So "is it finished" can no longer be read from the status, and the
 * button waits for the *composition time* to move past the one it queued
 * against. Without that, the first poll three seconds in would find the
 * untouched ready row and declare success.
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

type Phase = "idle" | "composing" | "slow" | "failed" | "refreshFailed";

export function GenerateDigestButton({
  locationId,
  label,
  composingLabel,
  slowLabel,
  failedLabel,
  refreshFailedLabel,
  disabledReason,
  refreshFailed,
}: {
  locationId: string;
  /** Names the week this composes — never "this week", which it is not. */
  label: string;
  composingLabel: string;
  slowLabel: string;
  /** A week that has never been composed could not be composed. */
  failedLabel: string;
  /** A published week could not be recomposed. It is still on screen. */
  refreshFailedLabel: string;
  /**
   * Why the button is unavailable, or null when it is. A reason rather than a
   * bare disabled control: "nothing happens and I cannot tell why" is the
   * complaint this whole wave is about.
   */
  disabledReason?: string | null;
  /** A refresh failed before this page load — the note survives a reload. */
  refreshFailed?: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(refreshFailed ? "refreshFailed" : "idle");
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

  const watch = useCallback(
    async (queuedAgainst: string | null) => {
      const deadline = Date.now() + POLL_TIMEOUT_MS;

      while (!stopped.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (stopped.current) return;

        const progress = await digestProgressAction({ locationId });

        // A failed *check* is not a failed digest — the job is probably fine, and
        // reporting a failure that did not happen is the worse error.
        if (!progress.ok) continue;

        if (progress.refreshFailed) {
          setPhase("refreshFailed");
          router.refresh();
          return;
        }

        // A first composition, which has no previous briefing behind it.
        if (progress.status === "failed") {
          setPhase("failed");
          return;
        }

        const landed = progress.generatedAt !== null && progress.generatedAt !== queuedAgainst;

        if (progress.status === "ready" && !progress.refreshing && landed) {
          setPhase("idle");
          // The digest is a server-rendered read, so re-fetching the tree is what
          // puts it on screen — and it arrives without losing scroll position.
          router.refresh();
          return;
        }
      }

      // Out of patience, not out of hope: the hourly sweep still finishes a week
      // that has never been composed. So this says "taking longer than
      // expected", never "broken".
      if (!stopped.current) setPhase("slow");
    },
    [locationId, router],
  );

  if (phase === "composing") {
    return (
      <p className="flex items-center gap-2 text-copy text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {composingLabel}
      </p>
    );
  }

  const note =
    phase === "slow"
      ? { text: slowLabel, tone: "text-muted-foreground" }
      : phase === "failed"
        ? { text: failedLabel, tone: "text-destructive" }
        : phase === "refreshFailed"
          ? // Not destructive: nothing was lost. The plan on the page is the one
            // that was there before, and it is still correct.
            { text: refreshFailedLabel, tone: "text-muted-foreground" }
          : disabledReason
            ? { text: disabledReason, tone: "text-muted-foreground" }
            : null;

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending || Boolean(disabledReason)}
        onClick={() => {
          run(() => generateDigestAction({ locationId }), {
            onSuccess: (result) => {
              setPhase("composing");
              void watch(result?.queuedAgainst ?? null);
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

      {/* Capped and right-aligned: unconstrained, a sentence in the page
          header's action slot stretches back across the subtitle and reads as
          part of it rather than as a note about the button above it. */}
      {note ? (
        <p className={`max-w-[22rem] text-copy sm:text-right ${note.tone}`}>{note.text}</p>
      ) : null}
    </div>
  );
}
