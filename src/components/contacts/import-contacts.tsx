"use client";

import { Loader2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAction } from "@/components/ui/use-action";
import { importContactsAction } from "@/server/contacts";

/**
 * Importing a customer list (W5-13).
 *
 * The file is read **in the browser** and posted as text. It is a CSV of a few
 * thousand lines, a server action takes it in one argument, and the alternative
 * — a multipart upload route — would be a second entry point that writes
 * personal data, with its own auth to get right.
 *
 * **It says what an import does not give you, before the upload.** A business
 * that imports four hundred customers and then finds every broadcast refused
 * has learned the rule at the worst possible moment. The line about permission
 * is the point of this component as much as the file input is.
 */
export function ImportContacts() {
  const t = useTranslations("contacts.import");
  const { run, pending } = useAction();
  const inputRef = useRef<HTMLInputElement>(null);
  const [tagLabel, setTagLabel] = useState("");
  const [summary, setSummary] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-pretty text-ink-400">{t("body")}</p>

      {/* Stated before the control, not after the result. */}
      <p className="text-copy text-muted-foreground">{t("noPermission")}</p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-52 flex-1 flex-col gap-1.5">
          <Label htmlFor="import-file">{t("fileLabel")}</Label>
          <Input
            id="import-file"
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            disabled={pending}
          />
        </div>

        <div className="flex w-48 flex-col gap-1.5">
          <Label htmlFor="import-tag">{t("tagLabel")}</Label>
          <Input
            id="import-tag"
            value={tagLabel}
            placeholder={t("tagPlaceholder")}
            disabled={pending}
            onChange={(event) => setTagLabel(event.target.value)}
          />
        </div>

        <Button
          type="button"
          disabled={pending}
          onClick={() => {
            const file = inputRef.current?.files?.[0];
            if (!file) return;

            run(
              async () => {
                const csv = await file.text();
                const outcome = await importContactsAction({
                  csv,
                  tagLabel: tagLabel.trim() || null,
                });

                if (outcome.ok) {
                  setSummary(
                    t("summary", {
                      created: outcome.result.created,
                      updated: outcome.result.updated,
                      skipped: outcome.result.skipped + outcome.invalid,
                      messageable: outcome.messageable,
                    }),
                  );
                  if (inputRef.current) inputRef.current.value = "";
                }

                return outcome;
              },
              // No success toast: the summary below is the result, and it says
              // considerably more than "done" would.
              { onError: () => setSummary(null) },
            );
          }}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Upload className="size-4" aria-hidden />
          )}
          {t("upload")}
        </Button>
      </div>

      {summary ? (
        <p className="text-body" role="status">
          {summary}
        </p>
      ) : null}
    </div>
  );
}
