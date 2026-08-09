"use client";

import { useAction } from "@/components/ui/use-action";
import {
  Check,
  ExternalLink,
  ChevronDown,
  Loader2,
  PenLine,
  Send,
  Signature,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { TemplatePicker } from "@/components/reviews/template-picker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  appendSignature,
  DEFAULT_REPLY_STYLE,
  REPLY_LENGTHS,
  REPLY_TONES,
  type ReplyLength,
  type ReplyStyle,
  type ReplyTone,
} from "@/replies/style";
import {
  discardReplyAction,
  draftReplyAction,
  postReplyAction,
  saveReplyAction,
  sendReplyAction,
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
 *
 * ## Tone, length, signature, regenerate (W4 fold-in)
 *
 * Three additions, and each earns its place by answering something the composer
 * previously could not:
 *
 *   - **Tone and length** hang off the draft button as a split menu rather than
 *     sitting on the surface as two selects. They are modifiers on one action,
 *     and a person who never opens them gets exactly the draft they got before.
 *   - **Regenerate** is the same draft action pressed again, which is why it
 *     appears on an existing *draft* and never on an approved reply — the server
 *     refuses that, and a button whose only outcome is an error is worse than no
 *     button. The text it replaces is kept, so "try again" is not a one-way
 *     door: `Undo2` puts the previous generation back without a second call.
 *   - **The signature** is the branch's, appended by the same idempotent helper
 *     the server uses on AI drafts. Offered rather than automatic on the
 *     hand-written path: somebody typing their own reply may well be signing it
 *     in their own words already.
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
  /** Start expanded — the caller decides, from whether a reply is owed. */
  openByDefault?: boolean;
  /** This branch's configured sign-off, or null when it has none (W5-12). */
  signature?: string | null;
  /**
   * Where the review lives on its own platform, when it has a public address.
   *
   * Used only to confirm a send: "posted to Google" with a link is the evidence
   * that the reply left the building, which is the one thing pressing the
   * button could not tell you (A22-B5). An Instagram DM and a first-party
   * submission have no such page, and the confirmation says so without a link.
   */
  reviewUrl?: string | null;
  /** The platform's own name, for that sentence. */
  sourceLabel?: string;
};

export function ReplyComposer({
  reviewId,
  reply,
  canUseAi,
  canApprove,
  maxChars,
  openByDefault = false,
  signature = null,
  reviewUrl = null,
  sourceLabel,
}: ReplyComposerProps) {
  const t = useTranslations("replies");
  const { run, pending } = useAction();

  // The server action revalidates, so a regenerated draft arrives as a new
  // prop. Tracking the prop we last rendered and resetting during render —
  // rather than in an effect — means the textarea never shows one frame of the
  // previous generation, and React documents this as the supported pattern.
  const [serverText, setServerText] = useState(reply?.text ?? "");
  const [text, setText] = useState(reply?.text ?? "");
  /**
   * The draft that was on screen before the last regeneration.
   *
   * Held in the component, not the database: it is a within-the-minute "no, the
   * other one was better", and persisting every superseded generation would
   * mean keeping copies of text somebody has explicitly discarded. Cleared on
   * every save, because once a version is stored it is the one that exists.
   */
  const [previousText, setPreviousText] = useState<string | null>(null);
  const [style, setStyle] = useState<ReplyStyle>(DEFAULT_REPLY_STYLE);
  /**
   * Open already when the review is waiting for a reply.
   *
   * The composer lives in a drawer that exists to read one review and answer
   * it, and it opened collapsed behind a "Write a reply" button — so the
   * ordinary path cost a click that could only ever be pressed. Front and
   * Superhuman both open with the field ready for the same reason.
   *
   * Conditional rather than always: an *answered* review is opened to check
   * what was said, not to say more, and an editor with a cursor in it invites a
   * second reply nobody asked for. `openByDefault` is the caller's judgement
   * (`!answered`), not a preference — the composer has no idea what it is
   * inside.
   *
   * Initial state only. Once somebody cancels, they meant it, and re-collapsing
   * or re-opening on the next render would fight them.
   */
  const [writing, setWriting] = useState(openByDefault);

  if (serverText !== (reply?.text ?? "")) {
    // A regeneration landed. Keep what it replaced — but only when there was
    // something to keep, or the first draft would offer to restore an empty
    // editor.
    if (serverText.trim().length > 0) setPreviousText(serverText);
    setServerText(reply?.text ?? "");
    setText(reply?.text ?? "");
  }

  const posted = reply?.status === "posted";
  const approved = reply?.status === "approved";
  const dirty = reply !== null && text.trim() !== reply.text.trim();
  const over = text.length > maxChars;
  const signed = signature !== null && appendSignature(text, signature) === text.trimEnd();

  const draft = (next: ReplyStyle) => run(() => draftReplyAction({ reviewId, style: next }));

  /**
   * What a successful send says (A22-B5).
   *
   * "It worked" was the whole of the old feedback, and the question somebody
   * actually has after pressing it is *did it reach Google*. Named, because a
   * reply posted to the wrong place is the failure this sentence rules out.
   */
  const sent = sourceLabel ? t("sentTo", { source: sourceLabel }) : t("sent");

  const draftControls = canUseAi ? (
    <DraftControls
      pending={pending}
      style={style}
      /**
       * Choosing a tone rewrites the draft (A22-B3).
       *
       * It used to set state and stop, so somebody who had a draft, thought
       * "too formal" and picked *Samimi* watched nothing happen — the button
       * beside the menu still said "Regenerate", and pressing it was a second
       * step nobody was told about. Silence after a deliberate choice is the
       * bug this whole wave is about.
       *
       * **Only when a draft already exists.** With an empty editor the button
       * still reads "Draft with AI" and the chosen stance is simply what it
       * will use — generating on the way past would spend a model call on a
       * menu the reader was still making their mind up in. One deliberate
       * choice, one generation, and the previous draft is kept for the "no, the
       * other one was better" that follows.
       */
      onStyleChange={(next) => {
        setStyle(next);
        if (reply !== null && !posted && !approved) draft(next);
      }}
      label={reply === null ? t("draftWithAi") : t("regenerate")}
      onDraft={() => draft(style)}
    />
  ) : null;

  const signatureButton =
    signature && !signed ? (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => setText((current) => appendSignature(current, signature))}
      >
        <Signature className="size-4" aria-hidden />
        {t("addSignature")}
      </Button>
    ) : null;

  const restoreButton =
    previousText !== null && previousText !== text ? (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => setText(previousText)}
      >
        <Undo2 className="size-4" aria-hidden />
        {t("restorePrevious")}
      </Button>
    ) : null;

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

        {/*
          **Where it went** (A22-B5).

          The panel said "posted" and stopped, so the one question left after
          pressing send — did this reach Google — was answered by going to look.
          A first-party submission and an Instagram DM have no public page, so
          the link is conditional and the sentence is not.
        */}
        {reviewUrl ? (
          <a
            href={reviewUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-copy font-medium text-primary hover:underline"
          >
            {sourceLabel ? t("openOn", { source: sourceLabel }) : t("openOnPlatform")}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        ) : null}
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

              {/*
                The AI draft, inside the editor — by the same argument the
                template above it already makes: it is something you drop *into*
                what you are writing, and it has to be reachable after you have
                started.

                It only lived in the collapsed row, which was survivable while
                the editor opened on a button press. It stopped being survivable
                when the drawer began opening the editor already expanded for an
                unanswered review: the product's differentiating feature ended
                up behind a "Cancel".

                It replaces the text rather than appending, which is what
                "draft" means and what the collapsed button always did.
              */}
              {draftControls}

              {signatureButton}

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
              // The `r` shortcut presses this when no editor is open yet, which
              // is what a person would do (W4.1).
              data-reply-start
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
              draftControls
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
            // What the `r` shortcut focuses (W4.1). An attribute rather than a
            // lifted "is the composer open" flag: this component owns the
            // draft, and moving that flag out would move the draft's lifetime
            // with it.
            data-reply-editor
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

            {/* Regenerating replaces a draft in place, which the server allows
                only while it *is* a draft — so this is absent once approved
                rather than present and refused. */}
            {approved ? null : draftControls}

            {approved ? null : restoreButton}

            {approved ? null : signatureButton}

            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending || !dirty || over || text.trim().length === 0}
              onClick={() =>
                run(async () => {
                  const result = await saveReplyAction({ replyId: reply.id, text });
                  // What is stored is now the only version there is.
                  if (result.ok) setPreviousText(null);
                  return result;
                })
              }
            >
              {t("save")}
            </Button>

            {/*
              **One press, for somebody who is both people** (A22-B5).

              Approve and post are two accountable acts when a member drafts and
              an admin signs off. They are one intention when the owner of the
              café is answering their own one-star review, and the product made
              them press twice through a state — "approved, not sent" — that
              means nothing to them and that the tester stopped at.

              So an unapproved draft gets *Yanıtı gönder*, which does both on the
              server in one transaction; an already-approved one still gets the
              plain post, because somebody else's signature is on it and this is
              only the second half. A member sees neither, and drafts for review
              exactly as before.
            */}
            {canApprove && !approved ? (
              <Button
                type="button"
                size="sm"
                // Saving first would hide an unsaved edit behind an approval
                // for text nobody signed off on.
                disabled={pending || dirty}
                title={dirty ? t("saveFirst") : undefined}
                onClick={() => run(() => sendReplyAction({ replyId: reply.id }), { success: sent })}
              >
                <Send className="size-4" aria-hidden />
                {t("send")}
              </Button>
            ) : null}

            {canApprove && approved ? (
              <Button
                type="button"
                size="sm"
                disabled={pending}
                onClick={() => run(() => postReplyAction({ replyId: reply.id }), { success: sent })}
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
    </div>
  );
}

/**
 * "Draft with AI", with its two modifiers behind a caret.
 *
 * A split button rather than two selects on the surface: tone and length are
 * settings *on* an action, not decisions of their own, and most drafts are
 * taken as they come. Putting them in the row would spend two controls' worth
 * of attention on something the majority never touches — the same argument
 * W4.4 made when it moved the report schedule off the Analytics page body.
 *
 * The chosen values are rendered under the button so a stance picked three
 * reviews ago is visible rather than surprising.
 */
function DraftControls({
  pending,
  style,
  onStyleChange,
  onDraft,
  label,
}: {
  pending: boolean;
  style: ReplyStyle;
  onStyleChange: (style: ReplyStyle) => void;
  onDraft: () => void;
  label: string;
}) {
  const t = useTranslations("replies");

  return (
    <span className="inline-flex items-center">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="rounded-r-none border-r-0"
        disabled={pending}
        onClick={onDraft}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Sparkles className="size-4" aria-hidden />
        )}
        {label}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="rounded-l-none px-2"
            disabled={pending}
            aria-label={t("styleLabel")}
          >
            <ChevronDown className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>

        {/* Wide enough that "As configured" and "Appreciative" stay on one
            line. A radio label that wraps reads as two options. */}
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuLabel>{t("tone")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={style.tone}
            onValueChange={(value) => onStyleChange({ ...style, tone: value as ReplyTone })}
          >
            {REPLY_TONES.map((tone) => (
              <DropdownMenuRadioItem key={tone} value={tone}>
                {t(`tones.${tone}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator />

          <DropdownMenuLabel>{t("length")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={style.length}
            onValueChange={(value) => onStyleChange({ ...style, length: value as ReplyLength })}
          >
            {REPLY_LENGTHS.map((length) => (
              <DropdownMenuRadioItem key={length} value={length}>
                {t(`lengths.${length}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
