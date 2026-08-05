"use client";

import { Send, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { sendMessageAction } from "@/server/messages";

/**
 * The reply box (P4-T3).
 *
 * **What it does not do is the interesting part: it never claims an intent.**
 * There is no "send as service message" control, because the basis a message
 * rests on is derived from what is being sent (`intentFor` in
 * `src/messaging/outbound.ts`) and a screen that could declare its own message
 * exempt would be a compliance hole with a nice label on it.
 *
 * What it *does* do is tell the truth in advance. When WhatsApp's 24-hour
 * window is shut, free text is not merely rejected by Meta — repeated attempts
 * damage the number's quality rating — so the box says so and offers the
 * templates instead, rather than letting somebody type three paragraphs and
 * then discover it.
 */

export type ComposerTemplate = {
  name: string;
  /** The rendered body in the reader's language, so the picker shows the text. */
  preview: string;
  variables: string[];
};

/** `send:no_consent` → `no_consent`. */
function refusalOf(code: string | undefined): string | null {
  return code?.startsWith("send:") ? code.slice("send:".length) : null;
}

export function Composer({
  contactId,
  channel,
  windowOpen,
  windowClosesAt,
  templates,
  canSend,
}: {
  contactId: string;
  channel: "whatsapp" | "sms";
  /**
   * Whether the 24-hour window is open. Null when we have never had a WhatsApp
   * message from this person — different from "closed", and the copy says so.
   */
  windowOpen: boolean | null;
  /** Already localised. Null when the window is not open. */
  windowClosesAt: string | null;
  templates: ComposerTemplate[];
  canSend: boolean;
}) {
  const t = useTranslations("messages");
  const router = useRouter();
  const [body, setBody] = useState("");
  const [template, setTemplate] = useState<string>(templates[0]?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Free text is only legal inside the window, and only on WhatsApp. On SMS
  // every message is business-initiated, so there is nothing a "reply" would
  // mean that a template does not already cover.
  const freeTextAllowed = channel === "whatsapp" && windowOpen === true;
  const selected = templates.find((entry) => entry.name === template);

  const send = () => {
    setError(null);
    startTransition(async () => {
      const result = freeTextAllowed
        ? await sendMessageAction({ kind: "reply", contactId, channel, body })
        : await sendMessageAction({
            kind: "template",
            contactId,
            channel,
            template,
            values: (selected?.variables ?? []).map((variable) => values[variable] ?? ""),
          });

      if (!result.ok) {
        const refusal = refusalOf(result.code);
        // The gate's own reasons get product copy; anything else falls back to
        // the message the server produced, which is already human-readable.
        setError(refusal && REFUSALS.has(refusal) ? t(`refusal.${refusal}`) : result.error);
        return;
      }

      setBody("");
      setValues({});
      router.refresh();
    });
  };

  if (!canSend) {
    return (
      <p className="px-(--card-px) pb-(--card-py) text-body text-ink-400">{t("cannotSend")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line px-(--card-px) pt-3 pb-(--card-py)">
      {/*
        The window's state, said plainly and before anything is typed. "Your
        message will go as a template because the customer last wrote to you on
        Tuesday" is the sentence somebody needs; discovering it after writing is
        the failure this replaces.
      */}
      {channel === "whatsapp" ? (
        <p className="flex items-start gap-1.5 text-meta text-faint">
          <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            {windowOpen === true
              ? t("windowOpen", { until: windowClosesAt ?? "" })
              : windowOpen === false
                ? t("windowClosed")
                : t("windowNever")}
          </span>
        </p>
      ) : (
        <p className="flex items-start gap-1.5 text-meta text-faint">
          <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{t("smsAlwaysCommercial")}</span>
        </p>
      )}

      {freeTextAllowed ? (
        <Textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          maxLength={1000}
          placeholder={t("replyPlaceholder")}
          aria-label={t("replyPlaceholder")}
        />
      ) : templates.length === 0 ? (
        <p className="text-body text-ink-400">{t("noTemplates")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <Select value={template} onValueChange={setTemplate}>
            <SelectTrigger aria-label={t("template")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {templates.map((entry) => (
                <SelectItem key={entry.name} value={entry.name}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {selected ? (
            <p className="rounded-md border border-line bg-surface-sunken px-3 py-2 text-body text-ink-400">
              {selected.preview}
            </p>
          ) : null}

          {(selected?.variables ?? []).map((variable) => (
            <label key={variable} className="grid gap-1">
              <span className="text-eyebrow text-faint uppercase">{variable}</span>
              <Textarea
                rows={1}
                maxLength={500}
                value={values[variable] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [variable]: event.target.value }))
                }
              />
            </label>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <Button
          size="sm"
          onClick={send}
          disabled={
            pending ||
            (freeTextAllowed ? body.trim().length === 0 : templates.length === 0 || !template)
          }
        >
          <Send aria-hidden />
          {pending ? t("sending") : t("send")}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-copy text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The gate's own vocabulary, so an unknown reason falls through to the server's words. */
const REFUSALS = new Set([
  "no_consent",
  "opted_out",
  "iys_not_configured",
  "iys_rejected",
  "no_open_session",
  "unknown_contact",
  "not_configured",
  "no_address",
  "send_failed",
]);
