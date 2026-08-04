"use client";

import { Check, Loader2, PenLine, Send, Sparkles, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { TemplatePicker } from "@/components/inbox/template-picker";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  approveReplyAction,
  discardReplyAction,
  draftReplyAction,
  postReplyAction,
  saveReplyAction,
  writeReplyAction,
} from "@/server/replies";

/**
 * Draft → edit → approve → post, on one review (P1a-T6).
 *
 * The four steps are separate buttons rather than one "Reply with AI", because
 * they are separate decisions and the middle two are where a human takes
 * responsibility. Posting is deliberately never one click away from
 * generating: an approved reply is the only thing that can be published, and
 * approval is its own action with its own audit row.
 *
 * A member can draft and edit; approving and posting need admin, and the
 * server enforces that regardless of what this component renders. `canApprove`
 * only decides whether to show a control that would fail.
 *
 * **Writing by hand is always available.** The AI draft is an accelerator, not
 * the entrance: it costs a model call and a slice of the monthly allowance, and
 * when that allowance runs out — or a plan never had it — an owner must still
 * be able to answer a customer. So "Write a reply" sits beside "Draft with AI"
 * and shares everything after it.
 */

export type ReplyState = {
  id: string;
  text: string;
  status: "draft" | "approved" | "posted" | "failed";
  aiGenerated: boolean;
  edited: boolean;
  lastError: string | null;
} | null;

export type ReplyComposerProps = {
  reviewId: string;
  reply: ReplyState;
  /** False when the plan has no `ai_replies`, so drafting is hidden not broken. */
  canUseAi: boolean;
  /** False for a member — approve and post are admin-only. */
  canApprove: boolean;
  maxChars: number;
};

export function ReplyComposer({
  reviewId,
  reply,
  canUseAi,
  canApprove,
  maxChars,
}: ReplyComposerProps) {
  const t = useTranslations("replies");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The server action revalidates, so a regenerated draft arrives as a new
  // prop. Tracking the prop we last rendered and resetting during render —
  // rather than in an effect — means the textarea never shows one frame of the
  // previous generation, and React documents this as the supported pattern.
  const [serverText, setServerText] = useState(reply?.text ?? "");
  const [text, setText] = useState(reply?.text ?? "");
  const [writing, setWriting] = useState(false);

  if (serverText !== (reply?.text ?? "")) {
    setServerText(reply?.text ?? "");
    setText(reply?.text ?? "");
  }

  const run = (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? t("failed"));
    });
  };

  const posted = reply?.status === "posted";
  const approved = reply?.status === "approved";
  const dirty = reply !== null && text.trim() !== reply.text.trim();
  const over = text.length > maxChars;

  if (posted) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/40 p-3">
        <p className="mb-1 flex items-center gap-1.5 text-copy font-medium text-muted-foreground">
          <Check className="size-3.5" aria-hidden />
          {t("posted")}
          {/* Provenance, always stated. In a team it is the difference between
              "the model wrote this" and "a colleague did". */}
          <span>
            · {reply.aiGenerated ? (reply.edited ? t("aiEdited") : t("aiWritten")) : t("written")}
          </span>
        </p>
        <p className="text-body leading-relaxed whitespace-pre-line">{reply.text}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {reply === null ? (
        writing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={text}
              rows={4}
              autoFocus
              placeholder={t("writePlaceholder")}
              aria-label={t("editorLabel")}
              className={cn(over && "border-destructive")}
              onChange={(event) => setText(event.target.value)}
              disabled={pending}
            />

            <div className="flex flex-wrap items-center gap-2">
              {/* Inside the editor, not beside "Write a reply": a template is
                  something you drop *into* what you are writing, and it must be
                  reachable after you have started rather than only before. */}
              <TemplatePicker
                reviewId={reviewId}
                disabled={pending}
                onPick={(body) => setText(body)}
              />

              <span
                className={cn(
                  "text-copy text-muted-foreground",
                  over && "font-medium text-destructive",
                )}
              >
                {text.length}/{maxChars}
              </span>

              <Button
                type="button"
                size="sm"
                className="ml-auto"
                disabled={pending || over || text.trim().length === 0}
                onClick={() => run(() => writeReplyAction({ reviewId, text }))}
              >
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {t("save")}
              </Button>

              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setWriting(false);
                  setText("");
                  setError(null);
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {/* Always first and always present: the one control that works
                whatever the plan and whatever the allowance. */}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => setWriting(true)}
            >
              <PenLine className="size-4" aria-hidden />
              {t("writeReply")}
            </Button>

            {/* A template needs no plan and no model call, so it sits with
                "write it yourself" on the always-available side of the row. */}
            <TemplatePicker
              reviewId={reviewId}
              disabled={pending}
              onPick={(body) => {
                setText(body);
                setWriting(true);
              }}
            />

            {canUseAi ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => run(() => draftReplyAction({ reviewId }))}
              >
                {pending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="size-4" aria-hidden />
                )}
                {t("draftWithAi")}
              </Button>
            ) : (
              <p className="text-copy text-muted-foreground">{t("notEntitled")}</p>
            )}
          </div>
        )
      ) : (
        <>
          <Textarea
            value={text}
            rows={4}
            aria-label={t("editorLabel")}
            className={cn(over && "border-destructive")}
            onChange={(event) => setText(event.target.value)}
          />

          <div className="flex flex-wrap items-center gap-2 text-copy text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5">
              {reply.aiGenerated ? (reply.edited ? t("aiEdited") : t("aiWritten")) : t("written")}
            </span>

            {approved ? (
              <span className="rounded bg-muted px-1.5 py-0.5">{t("approved")}</span>
            ) : null}

            <span className={cn("ml-auto tabular-nums", over && "text-destructive")}>
              {text.length}/{maxChars}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <TemplatePicker
              reviewId={reviewId}
              disabled={pending}
              onPick={(body) => setText(body)}
            />

            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending || !dirty || over || text.trim().length === 0}
              onClick={() => run(() => saveReplyAction({ replyId: reply.id, text }))}
            >
              {t("save")}
            </Button>

            {canApprove && !approved ? (
              <Button
                type="button"
                size="sm"
                // Saving first would hide an unsaved edit behind an approval
                // for text nobody signed off on.
                disabled={pending || dirty}
                title={dirty ? t("saveFirst") : undefined}
                onClick={() => run(() => approveReplyAction({ replyId: reply.id }))}
              >
                <Check className="size-4" aria-hidden />
                {t("approve")}
              </Button>
            ) : null}

            {canApprove && approved ? (
              <Button
                type="button"
                size="sm"
                disabled={pending}
                onClick={() => run(() => postReplyAction({ replyId: reply.id }))}
              >
                <Send className="size-4" aria-hidden />
                {t("post")}
              </Button>
            ) : null}

            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              disabled={pending}
              onClick={() => run(() => discardReplyAction({ replyId: reply.id }))}
            >
              <Trash2 className="size-4" aria-hidden />
              {t("discard")}
            </Button>
          </div>
        </>
      )}

      {reply?.lastError ? (
        <p className="text-copy text-destructive">{t("lastError", { reason: reply.lastError })}</p>
      ) : null}

      {error ? <p className="text-copy text-destructive">{error}</p> : null}
    </div>
  );
}
