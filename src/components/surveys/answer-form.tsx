"use client";

import { useState, useTransition } from "react";

/** Cited by the score group through `aria-describedby`. */
const ERROR_ID = "survey-score-error";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { bandFor, scalePoints, type SurveyType } from "@/surveys/scoring";
import { cn } from "@/lib/utils";

/**
 * The public survey form (P4-T2).
 *
 * **Read the props before the markup — the compliance rule is in them.**
 * `reviewInvite` is a single value handed in by the server. It is not a
 * function of the score, it is not an array indexed by band, and there is no
 * second one: whatever it holds is what *every* respondent is offered, at every
 * score. Routing a public-review invitation by sentiment is the prohibited
 * pattern (`docs/20` §Compliance), and the shape of this component is one of the
 * places that makes it unavailable rather than merely discouraged.
 *
 * The score decides exactly one thing, `privateFollowUp`, and it only ever
 * *adds* a place to write. Nothing is taken away from anybody.
 */

export type AnswerLabels = {
  low: string;
  high: string;
  comment: string;
  commentPlaceholder: string;
  submit: string;
  submitting: string;
  thanksTitle: string;
  thanksBody: string;
  followUpTitle: string;
  followUpBody: string;
  followUpPlaceholder: string;
  followUpSubmit: string;
  followUpThanks: string;
  reviewInviteBody: string;
  reviewInviteCta: string;
  errorScore: string;
  errorGeneric: string;
  errorClosed: string;
  errorAlreadyAnswered: string;
  errorRateLimited: string;
  /**
   * One accessible name per point on the scale, in `scalePoints` order.
   *
   * An array, not a `(score) => string`. **Functions cannot cross the RSC
   * boundary** — P3-T4 shipped exactly that bug on `/analytics` — so every
   * string is formatted on the server, where the locale lives, and arrives as
   * data.
   */
  scoreLabels: string[];
  /** Names the radio group as a whole. */
  scaleLegend: string;
};

type Stage = { name: "asking" } | { name: "answered"; token: string; score: number };

export function SurveyAnswerForm({
  type,
  token,
  slug,
  followUpEnabled,
  followUpPrompt,
  reviewInvite,
  answered,
  labels,
}: {
  type: SurveyType;
  /** Present when this person was invited by name. */
  token: string | null;
  /** Present when they arrived from a printed code. */
  slug: string | null;
  followUpEnabled: boolean;
  /** The business's own wording for the follow-up, if it wrote one. */
  followUpPrompt: string | null;
  /**
   * Where a public review is invited — **identical for every score**, because
   * the server computed it from the survey alone. Null when this survey does
   * not mention reviews at all.
   */
  reviewInvite: { url: string; external: boolean } | null;
  /** Set when the token has already been used, so we open on the thank-you. */
  answered: { score: number; token: string } | null;
  labels: AnswerLabels;
}) {
  const [stage, setStage] = useState<Stage>(
    answered
      ? { name: "answered", token: answered.token, score: answered.score }
      : { name: "asking" },
  );
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [followUpSent, setFollowUpSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    if (score === null) {
      setError(labels.errorScore);
      return;
    }

    setError(null);
    startTransition(async () => {
      const response = await fetch("/api/public/surveys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(token ? { token } : {}),
          ...(slug ? { slug } : {}),
          score,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        }),
      });

      const body = (await response.json().catch(() => null)) as
        { ok: true; token: string; score: number } | { ok: false; error: string } | null;

      if (!body?.ok) {
        const reason = body && "error" in body ? body.error : "server_error";
        setError(
          reason === "closed"
            ? labels.errorClosed
            : reason === "already_answered"
              ? labels.errorAlreadyAnswered
              : reason === "rate_limited"
                ? labels.errorRateLimited
                : reason === "invalid_score"
                  ? labels.errorScore
                  : labels.errorGeneric,
        );
        return;
      }

      setStage({ name: "answered", token: body.token, score: body.score });
    });
  };

  const sendFollowUp = (answeredToken: string) => {
    if (!followUp.trim()) return;

    setError(null);
    startTransition(async () => {
      const response = await fetch("/api/public/surveys/follow-up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: answeredToken, comment: followUp.trim() }),
      });

      if (!response.ok) {
        setError(labels.errorGeneric);
        return;
      }

      setFollowUpSent(true);
    });
  };

  if (stage.name === "answered") {
    // Computed here rather than sent from the server, because `bandFor` is pure
    // and db-free — and because doing it here makes it obvious that the *only*
    // thing downstream of the score is the private box.
    const band = bandFor(type, stage.score);
    const showFollowUp = followUpEnabled && band === "detractor";

    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-line bg-card p-8 text-center">
          <h2 className="text-title">{labels.thanksTitle}</h2>
          <p className="mt-2 text-body text-pretty text-muted-foreground">{labels.thanksBody}</p>
        </div>

        {showFollowUp && !followUpSent ? (
          <div className="rounded-lg border border-line bg-card p-6">
            <h3 className="text-title">{labels.followUpTitle}</h3>
            <p className="mt-1 text-body text-pretty text-muted-foreground">
              {followUpPrompt ?? labels.followUpBody}
            </p>
            <Textarea
              value={followUp}
              onChange={(event) => setFollowUp(event.target.value)}
              placeholder={labels.followUpPlaceholder}
              maxLength={2000}
              rows={4}
              className="mt-3"
            />
            <Button
              className="mt-3 w-full"
              disabled={pending || !followUp.trim()}
              onClick={() => sendFollowUp(stage.token)}
            >
              {labels.followUpSubmit}
            </Button>
          </div>
        ) : null}

        {followUpSent ? (
          <p role="status" className="text-center text-body text-muted-foreground">
            {labels.followUpThanks}
          </p>
        ) : null}

        {/*
          Offered to everyone who reaches this screen. There is no branch here
          on `band`, and there is deliberately nowhere to put one: `reviewInvite`
          arrived as a single value.
        */}
        {reviewInvite ? (
          <div className="rounded-lg border border-line bg-card p-6 text-center">
            <p className="text-body text-pretty text-muted-foreground">{labels.reviewInviteBody}</p>
            <Button asChild size="lg" className="mt-4 w-full">
              <a
                href={reviewInvite.url}
                {...(reviewInvite.external ? { rel: "noreferrer nofollow" } : {})}
              >
                {labels.reviewInviteCta}
              </a>
            </Button>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-center text-copy text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const points = scalePoints(type);

  return (
    <div className="rounded-lg border border-line bg-card p-6">
      <fieldset>
        {/* The scale is the question's answer set, so it is a radio group. */}
        <legend className="sr-only">{labels.scaleLegend}</legend>

        {/*
          A real radio group, not eleven toggle buttons.

          The comment above has said "so it is a radio group" since P4-T2 and
          the markup was `aria-pressed` — which announces "0, toggle button, not
          pressed" eleven times, with nothing saying the options belong to one
          question or how many there are. The star picker on `/c/{slug}` got
          `role="radio"` and `aria-checked` when it was built; this control,
          which is the whole of a survey, did not.

          Roving `tabIndex` and arrow keys come with the role: a radio group is
          one tab stop, and eleven of them in a row is eleven presses of Tab to
          get past a question somebody chose not to answer.
        */}
        <div
          role="radiogroup"
          aria-label={labels.scaleLegend}
          aria-invalid={error !== null || undefined}
          aria-describedby={error === null ? undefined : ERROR_ID}
          onKeyDown={(event) => {
            const step =
              event.key === "ArrowRight" || event.key === "ArrowDown"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowUp"
                  ? -1
                  : 0;
            if (step === 0) return;

            event.preventDefault();
            // From the current answer, or from the first point when there is
            // none — arrowing into an untouched scale should land somewhere.
            const current = score === null ? -1 : points.indexOf(score);
            const next = points[(current + step + points.length) % points.length];
            if (next === undefined) return;

            setScore(next);
            setError(null);
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-point="${next}"]`)?.focus();
          }}
          className={cn(
            "grid gap-1.5",
            // NPS is eleven buttons and has to wrap on a phone; CSAT is five and
            // never should. Sized from the scale rather than from the type, so a
            // future instrument gets sensible behaviour for free.
            points.length > 6 ? "grid-cols-6 sm:grid-cols-11" : "grid-cols-5",
          )}
        >
          {points.map((point, index) => (
            <button
              key={point}
              type="button"
              role="radio"
              data-point={point}
              aria-checked={score === point}
              // One tab stop for the group: focus lands on the answer if there
              // is one, otherwise on the first point.
              tabIndex={score === point || (score === null && index === 0) ? 0 : -1}
              aria-label={labels.scoreLabels[index] ?? String(point)}
              onClick={() => {
                setScore(point);
                setError(null);
              }}
              className={cn(
                "flex h-11 items-center justify-center rounded-md border text-copy font-semibold tabular-nums transition-colors",
                "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                score === point
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-line bg-card text-foreground hover:bg-surface-sunken",
              )}
            >
              {point}
            </button>
          ))}
        </div>

        {/* The ends of the scale, named. A bare row of numbers is ambiguous. */}
        <div className="mt-2 flex justify-between text-meta text-faint">
          <span>{labels.low}</span>
          <span>{labels.high}</span>
        </div>

        {/*
          Beside the control it is about, not under the button.

          "Please choose a score" sat below the submit button, two hundred
          pixels from the scale and after the comment box — so the eye was sent
          to the bottom of the form to be told about something at the top. The
          group cites it through `aria-describedby`, so it is read as part of
          the question rather than as a loose announcement.
        */}
        {error ? (
          <p id={ERROR_ID} role="alert" className="mt-3 text-copy text-destructive">
            {error}
          </p>
        ) : null}
      </fieldset>

      <div className="mt-5">
        <label htmlFor="survey-comment" className="text-copy font-medium">
          {labels.comment}
        </label>
        <Textarea
          id="survey-comment"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={labels.commentPlaceholder}
          maxLength={2000}
          rows={3}
          className="mt-1.5"
        />
      </div>

      <Button size="lg" className="mt-5 w-full" disabled={pending} onClick={submit}>
        {pending ? labels.submitting : labels.submit}
      </Button>
    </div>
  );
}
