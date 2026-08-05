"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sendSurveyAction, type SendSurveyResult } from "@/server/surveys";

/**
 * Sending a survey to a pasted list of addresses (P4-T2).
 *
 * The same shape as a review-request send, with one addition that is the whole
 * point of `docs/20`'s first compliance rule: **refusals are shown, with their
 * reasons**. A recipient we may not message is not quietly dropped from the
 * count — the screen says whether they opted out, whether İYS refused them, or
 * whether this deployment simply has no registry connection yet, because only
 * the last of those is something the person reading it can fix.
 */

/**
 * Translated in the component rather than handed a bag of labels.
 *
 * The counts are not known until the action returns, so a `(count) => string`
 * would have to cross the RSC boundary — which functions cannot do. The screens
 * under `(app)` render in the *reader's* locale, which is the one
 * `useTranslations` resolves, so this is both correct and the pattern the rest
 * of the app already uses. (The public `/s/{code}` form is the exception and
 * takes labels, because it renders in the **survey's** language rather than the
 * visitor's.)
 */
export function SurveySend({ surveyId }: { surveyId: string }) {
  const t = useTranslations("surveys");
  const [recipients, setRecipients] = useState("");
  const [result, setResult] = useState<SendSurveyResult | null>(null);
  const [pending, startTransition] = useTransition();

  const send = () => {
    setResult(null);
    startTransition(async () => {
      setResult(await sendSurveyAction({ surveyId, recipients }));
    });
  };

  return (
    <div className="flex flex-col gap-3 pb-(--card-py)">
      <div className="grid gap-1.5">
        <Label htmlFor="survey-recipients">{t("recipients")}</Label>
        <Textarea
          id="survey-recipients"
          value={recipients}
          onChange={(event) => setRecipients(event.target.value)}
          rows={5}
          placeholder={"ayse@example.com\nmehmet@example.com"}
        />
        <p className="text-meta text-faint">{t("recipientsHint")}</p>
      </div>

      <div>
        <Button onClick={send} disabled={pending || !recipients.trim()}>
          {pending ? t("sending") : t("send")}
        </Button>
      </div>

      {result && !result.ok ? (
        <p role="alert" className="text-copy text-destructive">
          {result.error}
        </p>
      ) : null}

      {result?.ok ? (
        <div className="flex flex-col gap-2" role="status">
          <p className="text-copy text-foreground">
            {(result.sent ?? 0) > 0
              ? t("sentCount", { count: result.sent ?? 0 })
              : t("nothingSent")}
          </p>

          {(result.failed ?? 0) > 0 ? (
            <p className="text-copy text-destructive">
              {t("failedCount", { count: result.failed ?? 0 })}
            </p>
          ) : null}

          {(result.invalid?.length ?? 0) > 0 ? (
            <p className="text-meta text-faint">
              {t("invalidCount", { count: result.invalid?.length ?? 0 })}
            </p>
          ) : null}

          {/*
            The compliance-visible part. Grouped by reason rather than listed per
            address: "48 have no consent on file" is the sentence an operator
            acts on, and forty-eight identical lines is the version they scroll
            past. The addresses are still there, one per row, underneath.
          */}
          {(result.refused?.length ?? 0) > 0 ? (
            <div className="rounded-md border border-line bg-surface-sunken px-3 py-2">
              <p className="text-copy font-semibold text-foreground">
                {t("refusedTitle", { count: result.refused?.length ?? 0 })}
              </p>
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {Object.entries(
                  (result.refused ?? []).reduce<Record<string, string[]>>((groups, entry) => {
                    groups[entry.reason] = [...(groups[entry.reason] ?? []), entry.email];
                    return groups;
                  }, {}),
                ).map(([reason, emails]) => (
                  <li key={reason}>
                    <p className="text-copy text-ink-400">
                      {refusalReason(t, reason)} — {emails.length}
                    </p>
                    <p className="truncate text-meta text-faint">{emails.join(", ")}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A gate refusal, in words.
 *
 * The set is `GateRefusal` from `src/compliance/gate.ts` and is deliberately
 * enumerated rather than interpolated: an unknown code falls back to itself, so
 * a reason added to the gate shows up as a slug on screen instead of an empty
 * string, and somebody notices.
 */
function refusalReason(t: (key: string) => string, reason: string): string {
  switch (reason) {
    case "no_consent":
    case "opted_out":
    case "iys_not_configured":
    case "iys_rejected":
    case "no_open_session":
    case "unknown_contact":
      return t(`refusal.${reason}`);
    default:
      return reason;
  }
}
