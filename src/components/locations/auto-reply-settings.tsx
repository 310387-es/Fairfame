"use client";

import { Loader2, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAction } from "@/components/ui/use-action";
import { setAutoReplyAction } from "@/server/locations";

/**
 * The auto-reply rule, on one branch (W5-6).
 *
 * Off is the default and the empty option is first, so nothing is enabled by
 * being ignored.
 *
 * **The preview is not decoration.** This is the one control in the product
 * that puts words on a public platform with nobody pressing anything
 * afterwards, so the exact sentence — template filled in, signature appended —
 * has to be readable *before* the switch is thrown. A rule whose output you
 * cannot see is a rule nobody should turn on.
 */
export function AutoReplySettings({
  locationId,
  templates,
  templateId,
  delayHours,
  preview,
  canManage,
}: {
  locationId: string;
  templates: { id: string; name: string; language: string }[];
  templateId: string | null;
  delayHours: number;
  /** What the chosen template would actually post, rendered on the server. */
  preview: string | null;
  canManage: boolean;
}) {
  const t = useTranslations("locations.autoReply");
  const { run, pending } = useAction();
  const [selected, setSelected] = useState(templateId ?? "");
  const [hours, setHours] = useState(String(delayHours));

  const dirty = selected !== (templateId ?? "") || hours !== String(delayHours);

  if (!canManage) {
    if (!templateId) return null;
    return (
      <div className="border-t border-line pt-4">
        <p className="text-copy text-muted-foreground">{t("readOnly", { hours: delayHours })}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-title">
          <Zap className="size-4 text-ink-400" aria-hidden />
          {t("heading")}
        </h3>
        <p className="text-copy text-muted-foreground">{t("description")}</p>
      </div>

      {templates.length === 0 ? (
        // Nothing to point the rule at. Saying so beats an empty select that
        // looks broken — and it names where templates are written.
        <p className="text-copy text-muted-foreground">{t("noTemplates")}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-56 flex-1 flex-col gap-1.5">
              <Label htmlFor={`auto-template-${locationId}`}>{t("templateLabel")}</Label>
              <select
                id={`auto-template-${locationId}`}
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
                disabled={pending}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-body"
              >
                {/* First, and it means off. */}
                <option value="">{t("off")}</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} ({template.language})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex w-32 flex-col gap-1.5">
              <Label htmlFor={`auto-delay-${locationId}`}>{t("delayLabel")}</Label>
              <Input
                id={`auto-delay-${locationId}`}
                type="number"
                min={1}
                max={336}
                value={hours}
                onChange={(event) => setHours(event.target.value)}
                disabled={pending || selected === ""}
              />
            </div>
          </div>

          {selected !== "" && preview && selected === templateId ? (
            <div className="rounded-lg border border-dashed border-line bg-muted/40 p-3">
              <p className="text-copy font-medium text-muted-foreground">{t("previewLabel")}</p>
              <p className="mt-1 text-body whitespace-pre-line">{preview}</p>
            </div>
          ) : null}

          <p className="text-copy text-muted-foreground">{t("scope")}</p>

          <div>
            <Button
              type="button"
              size="sm"
              disabled={pending || !dirty}
              onClick={() =>
                run(() =>
                  setAutoReplyAction({
                    locationId,
                    templateId: selected === "" ? null : selected,
                    delayHours: Number(hours) || 24,
                  }),
                )
              }
            >
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("save")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
