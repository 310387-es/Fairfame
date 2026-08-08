"use client";

import { Download, Loader2, Search, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAction } from "@/components/ui/use-action";
import {
  eraseSubjectAction,
  exportSubjectAction,
  lookupSubjectAction,
  type SubjectLookup,
} from "@/server/compliance";

/**
 * KVKK subject requests, by the identifier the person actually gave.
 *
 * The two functions behind this have existed since P1b-T5 and were reachable
 * only from a contact's profile — which assumes somebody has already found
 * them. A real request arrives as "please delete my data, my number is 0532…",
 * so the search box takes an email or a phone and the operator never has to go
 * looking through a contact list for a person who may not be in it.
 *
 * **A miss is an answer, not an error.** "We hold nothing about this person" is
 * frequently the correct response to a subject request and is exactly what an
 * operator has to be able to state confidently.
 *
 * Erasure asks twice, and the second press is a differently-worded button
 * rather than a `confirm()` — a browser dialog blocks the page and, per this
 * repo's own rule, is the one interaction that cannot be recovered from.
 */
export function SubjectRequests() {
  const t = useTranslations("compliance.kvkk");
  const { run, pending } = useAction();
  const [identifier, setIdentifier] = useState("");
  const [result, setResult] = useState<{ match: SubjectLookup | null } | null>(null);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setConfirming(false);
          run(async () => {
            const outcome = await lookupSubjectAction({ identifier });
            if (outcome.ok) setResult({ match: outcome.match });
            return outcome;
          });
        }}
      >
        <div className="flex min-w-60 flex-1 flex-col gap-1.5">
          <Label htmlFor="kvkk-identifier">{t("lookupLabel")}</Label>
          <Input
            id="kvkk-identifier"
            value={identifier}
            placeholder={t("lookupPlaceholder")}
            onChange={(event) => setIdentifier(event.target.value)}
            disabled={pending}
          />
        </div>

        <Button type="submit" variant="outline" disabled={pending || identifier.trim().length < 3}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Search className="size-4" aria-hidden />
          )}
          {t("lookup")}
        </Button>
      </form>

      {result === null ? null : result.match === null ? (
        <p className="text-copy text-muted-foreground" role="status">
          {t("noMatch")}
        </p>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <p className="text-body">
            <span className="font-medium">{result.match.name ?? t("unnamed")}</span>{" "}
            <span className="text-muted-foreground">
              {[result.match.email, result.match.phone].filter(Boolean).join(" · ")}
            </span>
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const outcome = await exportSubjectAction({ contactId: result.match!.contactId });
                  // Built in the browser from data the server already returned:
                  // a download route would be a second, unauthenticated-looking
                  // way to read a person's whole file.
                  if (outcome.ok) downloadJson(outcome.subject, result.match!.contactId);
                  return outcome;
                })
              }
            >
              <Download className="size-4" aria-hidden />
              {t("export")}
            </Button>

            {confirming ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() =>
                  run(
                    async () => {
                      const outcome = await eraseSubjectAction({
                        contactId: result.match!.contactId,
                      });
                      if (outcome.ok) {
                        setResult(null);
                        setConfirming(false);
                        setIdentifier("");
                      }
                      return outcome;
                    },
                    { success: t("erased") },
                  )
                }
              >
                <Trash2 className="size-4" aria-hidden />
                {t("eraseConfirm")}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setConfirming(true)}
              >
                <Trash2 className="size-4" aria-hidden />
                {t("erase")}
              </Button>
            )}

            {confirming ? (
              <p className="text-copy text-muted-foreground">{t("eraseWarning")}</p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/** Hands the export to the browser as a file, without a route to fetch it from. */
function downloadJson(data: unknown, contactId: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `kvkk-${contactId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
