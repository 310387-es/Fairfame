"use client";

import { Star } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * The public review form.
 *
 * Its strings arrive as props rather than through `useTranslations`, because
 * this page renders in the *campaign's* language — which has nothing to do with
 * the locale cookie the visitor's browser may be carrying.
 *
 * There is one form, and it is the same form for every rating. No branch here
 * inspects `rating` before deciding what to show or where to send anyone: a
 * one-star submission takes exactly the path a five-star submission takes.
 * That is the rating-gating prohibition (docs/02-prd.md R2) expressed where it
 * can actually be violated.
 */

export type SubmissionLabels = {
  ratingLabel: string;
  ratingHint: string;
  /**
   * One accessible label per star, already formatted. Formatting happens on the
   * server because the message carries an ICU placeholder ("5 üzerinden
   * {rating}"), and asking for it without a value yields the message key.
   */
  starLabels: string[];
  comment: string;
  commentPlaceholder: string;
  name: string;
  namePlaceholder: string;
  email: string;
  emailPlaceholder: string;
  emailHint: string;
  kvkkLabel: string;
  submit: string;
  submitting: string;
  thanksTitle: string;
  thanksBody: string;
  errorRating: string;
  errorKvkk: string;
  errorGeneric: string;
  errorRateLimited: string;
  errorAlreadySubmitted: string;
  errorClosed: string;
};

const RATINGS = [1, 2, 3, 4, 5] as const;

export function SubmissionForm({
  slug,
  requestToken,
  labels,
}: {
  slug: string;
  requestToken: string | null;
  labels: SubmissionLabels;
}) {
  const [rating, setRating] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [email, setEmail] = useState("");
  const [kvkkAccepted, setKvkkAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  if (done) {
    return (
      <div className="rounded-lg border border-line bg-card p-8 text-center">
        <p className="text-display">{labels.thanksTitle}</p>
        <p className="mt-2 text-body text-pretty text-muted-foreground">{labels.thanksBody}</p>
      </div>
    );
  }

  function submit(formData: FormData) {
    setError(null);

    if (rating === null) {
      setError(labels.errorRating);
      return;
    }
    if (email.trim() !== "" && !kvkkAccepted) {
      setError(labels.errorKvkk);
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch("/api/public/reviews", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            slug,
            requestToken,
            rating,
            comment: formData.get("comment") ?? "",
            authorName: formData.get("authorName") ?? null,
            email: email.trim() === "" ? null : email.trim(),
            kvkkAccepted,
          }),
        });

        if (response.ok) {
          setDone(true);
          return;
        }

        const body: unknown = await response.json().catch(() => null);
        const code =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : "server_error";

        setError(
          {
            rate_limited: labels.errorRateLimited,
            already_submitted: labels.errorAlreadySubmitted,
            closed: labels.errorClosed,
          }[code] ?? labels.errorGeneric,
        );
      } catch {
        setError(labels.errorGeneric);
      }
    });
  }

  return (
    <form action={submit} className="space-y-6">
      <fieldset>
        <legend className="text-title">{labels.ratingLabel}</legend>
        <p className="mt-1 mb-3 text-body text-muted-foreground">{labels.ratingHint}</p>

        <div className="flex gap-1" onMouseLeave={() => setHovered(null)}>
          {RATINGS.map((value) => {
            const filled = value <= (hovered ?? rating ?? 0);
            return (
              <button
                key={value}
                type="button"
                // Radio semantics without a radio's look: assistive technology
                // gets the state, everyone else gets stars.
                role="radio"
                aria-checked={rating === value}
                aria-label={labels.starLabels[value - 1] ?? String(value)}
                onMouseEnter={() => setHovered(value)}
                onClick={() => setRating(value)}
                className="rounded-md p-1 transition-transform hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <Star
                  className={cn(
                    "size-9",
                    filled ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40",
                  )}
                  aria-hidden
                />
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="comment">{labels.comment}</Label>
        <Textarea
          id="comment"
          name="comment"
          maxLength={5000}
          placeholder={labels.commentPlaceholder}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="authorName">{labels.name}</Label>
          <Input
            id="authorName"
            name="authorName"
            maxLength={120}
            placeholder={labels.namePlaceholder}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">{labels.email}</Label>
          <Input
            id="email"
            name="email"
            type="email"
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={labels.emailPlaceholder}
          />
        </div>
      </div>

      {/* Only asked for when contact details are given — a walk-in leaving an
          anonymous rating is not handing us identifiable data. */}
      {email.trim() !== "" ? (
        <label className="flex items-start gap-2 text-body text-muted-foreground">
          <input
            type="checkbox"
            checked={kvkkAccepted}
            onChange={(event) => setKvkkAccepted(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 rounded border-input accent-foreground"
          />
          <span>{labels.kvkkLabel}</span>
        </label>
      ) : (
        <p className="text-body text-muted-foreground">{labels.emailHint}</p>
      )}

      {error ? (
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? labels.submitting : labels.submit}
      </Button>
    </form>
  );
}
