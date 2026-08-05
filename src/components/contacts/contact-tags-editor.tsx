"use client";

import { Plus, Tag, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { chipClassName } from "@/components/ds/chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAction } from "@/components/ui/use-action";
import { addContactTagAction, removeContactTagAction } from "@/server/contacts";

/**
 * Tagging one person (P4-T1).
 *
 * The existing labels are offered as an inline list rather than as an
 * autocomplete: an organization has a handful of them, and a dropdown that has
 * to be opened to discover what everybody else is already using is how a
 * vocabulary of four becomes a vocabulary of nine. Typing a new one is still
 * one field away.
 *
 * The typed label is normalised server-side and may come back **changed** — if
 * the organization already uses "VIP", typing "vip" gets you "VIP". That is the
 * whole point of the adoption rule in `src/contacts/tags.ts`, and the list
 * re-renders from the server so the screen shows what was actually stored
 * rather than what was typed.
 */
export function ContactTagsEditor({
  contactId,
  tags,
  suggestions,
  canEdit,
}: {
  contactId: string;
  tags: { slug: string; label: string }[];
  /** The organization's other labels, most-used first, minus the ones on here. */
  suggestions: { slug: string; label: string }[];
  canEdit: boolean;
}) {
  const t = useTranslations("contacts");
  const tf = useTranslations("feedback");
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const { run, pending } = useAction();

  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;

    run(() => addContactTagAction({ contactId, label: trimmed }), {
      success: tf("saved"),
      onSuccess: () => {
        setLabel("");
        setAdding(false);
      },
    });
  };

  const remove = (slug: string) => {
    run(() => removeContactTagAction({ contactId, slug }), { success: tf("deleted") });
  };

  return (
    <div className="flex flex-col gap-2 pb-(--card-py)">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.length === 0 && !canEdit ? (
          <p className="text-body text-ink-400">{t("noTags")}</p>
        ) : null}

        {tags.map((tag) => (
          <span key={tag.slug} className="inline-flex items-center">
            <span className={`${chipClassName(false)} ${canEdit ? "rounded-r-none pr-2" : ""}`}>
              <Tag className="size-3" aria-hidden />
              {tag.label}
            </span>
            {canEdit ? (
              <button
                type="button"
                onClick={() => remove(tag.slug)}
                disabled={pending}
                aria-label={t("removeTag", { label: tag.label })}
                className={`${chipClassName(false)} -ml-px rounded-l-none px-2 disabled:opacity-60`}
              >
                <X className="size-3" aria-hidden />
              </button>
            ) : null}
          </span>
        ))}

        {canEdit && !adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={`${chipClassName(false)} border-dashed`}
          >
            <Plus className="size-3" aria-hidden />
            {t("addTag")}
          </button>
        ) : null}
      </div>

      {adding ? (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid min-w-40 flex-1 gap-1.5">
              <label htmlFor="contact-tag" className="text-eyebrow text-faint uppercase">
                {t("addTag")}
              </label>
              <Input
                id="contact-tag"
                value={label}
                maxLength={40}
                autoFocus
                onChange={(event) => setLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    add(label);
                  }
                }}
                placeholder={t("tagPlaceholder")}
              />
            </div>
            <div className="flex items-center gap-2 pb-1">
              <Button size="sm" onClick={() => add(label)} disabled={pending || !label.trim()}>
                {t("addTagSubmit")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                }}
                disabled={pending}
              >
                {t("cancel")}
              </Button>
            </div>
          </div>

          {suggestions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-eyebrow text-faint uppercase">{t("tagSuggestions")}</span>
              {suggestions.slice(0, 8).map((tag) => (
                <button
                  key={tag.slug}
                  type="button"
                  onClick={() => add(tag.label)}
                  disabled={pending}
                  className={`${chipClassName(false)} disabled:opacity-60`}
                >
                  {tag.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
