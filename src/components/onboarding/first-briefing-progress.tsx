"use client";

import { CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Meter } from "@/components/ds/meter";
import { useAction } from "@/components/ui/use-action";
import {
  advanceFirstBriefingAction,
  onboardingProgressAction,
  type FirstBriefingProgress,
} from "@/server/onboarding";

/**
 * The welcome screen's engine (W5-14).
 *
 * It calls `advanceFirstBriefingAction` in a loop until there is a briefing to
 * go to. **The loop is here rather than in a job** so the first briefing works
 * with no worker process, and so the number on screen is the number the server
 * just produced rather than a poll of something that may not be running — see
 * the module comment on `src/server/onboarding.ts`.
 *
 * Two rules it follows, both learned the hard way elsewhere in this codebase:
 *
 *   - **The loop is a chain of awaits, not an interval.** A batch is ten model
 *     calls, which at a free tier's twelve-a-minute is the better part of a
 *     minute; a timer that fired regardless would stack requests, each one
 *     analysing the batch the last is still working on.
 *   - **Reading the count is a second, cheap poll.** With only the first, the
 *     bar sat at "0 of 15" for a whole batch before jumping — which is
 *     indistinguishable from a hang, at exactly the moment a new customer is
 *     deciding whether the product works. `onboardingProgressAction` writes
 *     nothing and answers in one query.
 *   - **A way out is always on screen.** Analysis can be slow, refused by a
 *     provider, or capped by a plan. "Skip to the dashboard" is never hidden
 *     behind a failure, because a progress bar with no exit is how a signup
 *     ends in a closed tab.
 */
export function FirstBriefingProgressView({
  locationId,
  initial,
}: {
  locationId: string;
  initial: FirstBriefingProgress;
}) {
  const t = useTranslations("onboarding");
  const router = useRouter();
  const { run } = useAction();
  const [progress, setProgress] = useState(initial);
  const [failed, setFailed] = useState(false);
  // React 18 mounts effects twice in development; a second loop would double
  // every batch. The ref is what makes this run once.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    let cancelled = false;

    // The cheap read, beside the expensive work. It never reports `finished` —
    // only the worker knows that, and a reader saying so would navigate away
    // mid-batch.
    const ticker = setInterval(() => {
      void onboardingProgressAction({ locationId }).then((result) => {
        if (cancelled || !result.ok) return;
        setProgress((current) =>
          current.finished
            ? current
            : {
                ...current,
                analysed: result.progress.analysed,
                analysable: result.progress.analysable,
              },
        );
      });
    }, 2_000);

    /*
      The whole loop is one `useAction` call, not one per batch.

      `advanceFirstBriefingAction` *mutates* — it writes insights and composes a
      digest — and `tests/lib/action-feedback.test.ts` requires every mutation
      to report through `useAction` rather than name itself an exemption. One
      `run()` around the loop is the honest shape: a failure toasts once, which
      is what happened, instead of six times; `pending` stays true for as long
      as the work actually takes; and the bar underneath keeps reporting
      progress from its own cheap read.
    */
    run(
      async () => {
        // Up to sixty steps. At ten reviews a step that is six hundred reviews,
        // far past what any onboarding needs — it exists so a provider that
        // returns without analysing anything cannot spin forever.
        let last = await advanceFirstBriefingAction({ locationId });

        for (let step = 0; step < 60 && !cancelled; step += 1) {
          if (!last.ok) return last;
          if (cancelled) return last;

          setProgress(last.progress);

          if (last.progress.finished) {
            if (last.progress.digestId) {
              router.replace(`/weekly-plan/${last.progress.digestId}`);
            }
            return last;
          }

          last = await advanceFirstBriefingAction({ locationId });
        }

        return last;
      },
      {
        // Both branches stop the ticker. Without it a failed run leaves a dead
        // screen polling every two seconds for as long as the tab is open.
        onSuccess: () => clearInterval(ticker),
        // The screen already says what went wrong, in its own words and in
        // place; `onError` is what stops the bar rendering as still working.
        onError: () => {
          setFailed(true);
          clearInterval(ticker);
        },
      },
    );

    return () => {
      cancelled = true;
      clearInterval(ticker);
    };
    // `run` is stable per `useAction` instance; listing it would re-run the
    // effect on every render and the ref guard would then be the only thing
    // between this and an unbounded number of loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, router]);

  const done = progress.finished || failed;

  return (
    <div className="flex flex-col items-center gap-5 py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
        {done ? (
          <CheckCircle2 className="size-6" aria-hidden />
        ) : (
          <Sparkles className="size-6" aria-hidden />
        )}
      </span>

      <div className="max-w-prose">
        <h1 className="text-display">{t("title")}</h1>
        <p className="mt-1.5 text-body text-muted-foreground">{t("body")}</p>
      </div>

      <div className="w-full max-w-sm">
        {/* The denominator is reviews *with text*, because a rating with no
            words is nothing for analysis to do — counting it would leave the
            bar permanently short of the end. */}
        <Meter
          label={t("analysing")}
          percent={progress.analysable === 0 ? 0 : (progress.analysed / progress.analysable) * 100}
          value={`${progress.analysed}/${progress.analysable}`}
          srLabel={t("counted", { done: progress.analysed, total: progress.analysable })}
        />
        <p className="mt-1.5 text-copy text-muted-foreground" aria-live="polite">
          {failed
            ? t("failed")
            : progress.empty
              ? t("empty")
              : progress.finished
                ? t("done")
                : t("counted", { done: progress.analysed, total: progress.analysable })}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        {progress.digestId ? (
          <Button onClick={() => router.replace(`/weekly-plan/${progress.digestId}`)}>
            {t("openBriefing")}
          </Button>
        ) : null}

        {/* Always present, never conditional on failure. */}
        <Button
          variant={progress.digestId ? "ghost" : "outline"}
          onClick={() => router.push("/dashboard")}
        >
          {!done && !progress.digestId ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : null}
          {t("skip")}
        </Button>
      </div>
    </div>
  );
}
