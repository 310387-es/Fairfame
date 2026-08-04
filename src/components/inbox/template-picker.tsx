"use client";

import { FileText, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { listTemplatesForReviewAction, type PickableTemplate } from "@/server/reply-templates";

/**
 * "Use a template" (P2-T5).
 *
 * Loads on open rather than with the card. Twenty review cards each carrying the
 * organization's whole template list is the same list serialized twenty times,
 * for a control most readers never touch — and the bodies have to be rendered
 * per review anyway, so there is nothing to share between cards.
 *
 * Choosing one **fills the editor, and stops**. It does not save, approve or
 * post: a template is a starting point that a person still reads and signs off,
 * which is the difference between a canned reply and an automated one.
 */
export function TemplatePicker({
  reviewId,
  onPick,
  disabled,
}: {
  reviewId: string;
  onPick: (body: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("replies");
  const [templates, setTemplates] = useState<PickableTemplate[] | null>(null);
  const [pending, startTransition] = useTransition();

  const load = (open: boolean) => {
    if (!open || templates !== null) return;
    startTransition(async () => {
      setTemplates(await listTemplatesForReviewAction({ reviewId }));
    });
  };

  return (
    <DropdownMenu onOpenChange={load}>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="outline" disabled={disabled}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <FileText className="size-4" aria-hidden />
          )}
          {t("useTemplate")}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="max-w-80">
        {templates === null ? (
          <DropdownMenuItem disabled>{t("templatesLoading")}</DropdownMenuItem>
        ) : templates.length === 0 ? (
          <DropdownMenuItem disabled>{t("templatesEmpty")}</DropdownMenuItem>
        ) : (
          templates.map((template) => (
            <DropdownMenuItem
              key={template.id}
              onSelect={() => onPick(template.body)}
              className="flex-col items-start gap-0.5"
            >
              <span className="flex w-full items-center gap-1.5 font-medium">
                {template.name}
                <span className="ml-auto text-[10px] text-muted-foreground uppercase">
                  {template.language}
                </span>
              </span>
              {/* One line of the body: enough to tell two "thank you" templates
                  apart without turning the menu into a document. */}
              <span className="line-clamp-2 text-copy text-muted-foreground">{template.body}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
