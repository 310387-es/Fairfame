"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/config";
import { TEMPLATE_VARIABLES } from "@/replies/template-vars";
import { deleteReplyTemplateAction, saveReplyTemplateAction } from "@/server/reply-templates";

/**
 * Managing reply templates (P2-T5).
 *
 * Admin-only, and the server says so too — this component decides whether to
 * render a control that would be refused, nothing more.
 *
 * A Turkish template and its English sibling are two rows, not one row with two
 * translations. A good reply in one language is rarely a translation of the
 * other, and treating them as a pair would force whoever writes the second one
 * to work from the first instead of writing what a Turkish customer should
 * actually read.
 */

export type TemplateRow = {
  id: string;
  name: string;
  body: string;
  language: string;
  tags: string[];
};

type Draft = { id?: string; name: string; body: string; language: Locale };

export function TemplateManager({
  templates,
  canManage,
  maxChars,
  defaultLanguage,
}: {
  templates: TemplateRow[];
  canManage: boolean;
  maxChars: number;
  defaultLanguage: Locale;
}) {
  const t = useTranslations("templates");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const over = (draft?.body.length ?? 0) > maxChars;

  const save = () => {
    if (!draft) return;
    setError(null);

    startTransition(async () => {
      const result = await saveReplyTemplateAction(draft);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraft(null);
    });
  };

  const remove = (id: string) => {
    setError(null);
    startTransition(async () => {
      const result = await deleteReplyTemplateAction({ id });
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {templates.length === 0 && draft === null ? (
        <p className="text-body text-muted-foreground">{t("empty")}</p>
      ) : null}

      {templates.map((template) => (
        <div
          key={template.id}
          className="flex flex-col gap-2 rounded-md border border-line p-4 sm:flex-row sm:items-start"
        >
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2">
              <span className="text-copy font-semibold">{template.name}</span>
              <Badge variant="secondary">{template.language.toUpperCase()}</Badge>
              {template.tags.map((tag) => (
                <Badge key={tag} variant="accent">
                  {tag}
                </Badge>
              ))}
            </p>
            <p className="mt-1 text-body whitespace-pre-line text-muted-foreground">
              {template.body}
            </p>
          </div>

          {canManage ? (
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  setDraft({
                    id: template.id,
                    name: template.name,
                    body: template.body,
                    language: (LOCALES as readonly string[]).includes(template.language)
                      ? (template.language as Locale)
                      : defaultLanguage,
                  })
                }
              >
                <Pencil className="size-4" aria-hidden />
                <span className="sr-only">{t("edit", { name: template.name })}</span>
              </Button>

              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => remove(template.id)}
              >
                <Trash2 className="size-4" aria-hidden />
                <span className="sr-only">{t("delete", { name: template.name })}</span>
              </Button>
            </div>
          ) : null}
        </div>
      ))}

      {draft ? (
        <div className="flex flex-col gap-3 rounded-md border border-line p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <div className="grid gap-1.5">
              <Label htmlFor="template-name">{t("name")}</Label>
              <Input
                id="template-name"
                value={draft.name}
                maxLength={60}
                autoFocus
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="template-language">{t("language")}</Label>
              <Select
                value={draft.language}
                onValueChange={(next) => setDraft({ ...draft, language: next as Locale })}
              >
                <SelectTrigger id="template-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOCALES.map((locale) => (
                    <SelectItem key={locale} value={locale}>
                      {LOCALE_LABELS[locale]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="template-body">{t("body")}</Label>
            <Textarea
              id="template-body"
              value={draft.body}
              rows={4}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            />
            <p className="flex flex-wrap items-center gap-1.5 text-meta text-faint">
              {/*
                The token names come from the code, not from the translations.
                They are not words — they are identifiers the substituter matches
                on — and putting `{{author}}` in an ICU message would have it
                parsed as a placeholder rather than printed as one.
              */}
              <span>{t("variables")}</span>
              {TEMPLATE_VARIABLES.map((variable) => (
                <code key={variable} className="rounded bg-muted px-1 font-mono">
                  {`{{${variable}}}`}
                </code>
              ))}
              <span className={over ? "ml-auto font-medium text-destructive" : "ml-auto"}>
                {draft.body.length}/{maxChars}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={pending || over || draft.name.trim() === "" || draft.body.trim() === ""}
              onClick={save}
            >
              {t("save")}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDraft(null)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : canManage ? (
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setDraft({ name: "", body: "", language: defaultLanguage })}
          >
            <Plus className="size-4" aria-hidden />
            {t("add")}
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-copy text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
