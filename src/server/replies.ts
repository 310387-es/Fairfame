"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { childLogger } from "@/lib/logger";
import { MAX_REPLY_CHARS } from "@/prompts/index";
import { REPLY_LENGTHS, REPLY_TONES } from "@/replies/style";
import {
  approveReply,
  discardReply,
  draftReplyForReview,
  postReply,
  ReplyError,
  saveReplyDraft,
  writeReplyDraft,
} from "@/replies/service";
import { invalidInput, toActionResult, type ActionResult } from "@/server/action-result";

/**
 * Reply actions (P1a-T6).
 *
 * Thin: parse, delegate, translate errors. The entitlement gate, the state
 * machine and the audit trail live in `src/replies/service.ts`, so nothing
 * depends on a route handler remembering to check them.
 *
 * Roles follow the consequence. Drafting and editing are `member` — that is
 * ordinary work. **Approving and posting are `admin`**, because those two put
 * words on a public platform under the business's name, and the person who can
 * write a draft is not automatically the person who should be able to publish
 * it.
 */

const log = childLogger({ module: "server/replies" });

/**
 * The draft request, with its optional style.
 *
 * `z.enum` over the closed lists rather than a free string: tone and length
 * reach the *instruction* half of a prompt, and the one rule this codebase has
 * about that position is that only bounded values may occupy it.
 */
const draftSchema = z.object({
  reviewId: z.uuid(),
  style: z.object({ tone: z.enum(REPLY_TONES), length: z.enum(REPLY_LENGTHS) }).optional(),
});
const replyIdSchema = z.object({ replyId: z.uuid() });
const saveSchema = z.object({
  replyId: z.uuid(),
  text: z.string().trim().min(1).max(MAX_REPLY_CHARS),
});

/**
 * Maps a domain failure to something worth showing a person.
 *
 * Generic in the success payload it will never produce: every branch here is a
 * failure, and typing the return as bare `ActionResult` forced a cast at the
 * one call site that promises data back (W4.3). A cast at a failure boundary is
 * the wrong place to have one — it is exactly where a shape mistake would be
 * least visible.
 */
function toReplyResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ReplyError) return { ok: false, error: error.message };
  return toActionResult(error);
}

/**
 * Drafts a reply, and hands the text back (W4.3).
 *
 * It used to return bare `{ ok: true }` and rely on `revalidatePath` to put the
 * draft on screen, which works on the Inbox because the composer is already
 * rendered there. Home's queue has no composer — and the audit asks for a
 * one-click AI reply *in* the queue — so the caller needs the words. The draft
 * is still written to the database exactly as before; this only stops throwing
 * away something we already have.
 *
 * It remains a **draft**. Approving and posting are `admin` and live where a
 * person can read the thing before it goes to a customer, and one click on a
 * dashboard must never be one click from publishing.
 */
export async function draftReplyAction(input: {
  reviewId: string;
  style?: { tone: string; length: string };
}): Promise<ActionResult<{ text: string }>> {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid review.");

  try {
    const reply = await withAuthenticatedTenant(
      async (tx, actor) =>
        draftReplyForReview({
          tx,
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          reviewId: parsed.data.reviewId,
          // Absent means "as configured" — the same draft this action produced
          // before styles existed, which is what Home's one-click queue asks
          // for and what the digest pipeline needs from the service beneath it.
          ...(parsed.data.style ? { style: parsed.data.style } : {}),
        }),
      { minimumRole: "member" },
    );

    revalidatePath("/", "layout");
    return { ok: true, text: reply.text };
  } catch (error) {
    log.warn({ err: error }, "draftReply failed");
    return toReplyResult<{ text: string }>(error);
  }
}

/**
 * Stores a reply the user wrote themselves.
 *
 * `member`, like AI drafting — writing is not publishing, and approving and
 * posting stay `admin`. No AI entitlement and no usage counter: see
 * `writeReplyDraft` for why metering a typed sentence against the model
 * allowance would lock an owner out of their own Inbox.
 */
export async function writeReplyAction(input: {
  reviewId: string;
  text: string;
}): Promise<ActionResult> {
  const parsed = z
    .object({ reviewId: z.uuid(), text: z.string().min(1).max(4_000) })
    .safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Write something first.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await writeReplyDraft({
          tx,
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          reviewId: parsed.data.reviewId,
          text: parsed.data.text,
        });
      },
      { minimumRole: "member" },
    );

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "writeReply failed");
    return toReplyResult(error);
  }
}

export async function saveReplyAction(input: {
  replyId: string;
  text: string;
}): Promise<ActionResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput(
      parsed.error,
      `A reply must be between 1 and ${MAX_REPLY_CHARS} characters.`,
    );
  }

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await saveReplyDraft({
          tx,
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          replyId: parsed.data.replyId,
          text: parsed.data.text,
        });
      },
      { minimumRole: "member" },
    );

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "saveReply failed");
    return toReplyResult(error);
  }
}

export async function approveReplyAction(input: { replyId: string }): Promise<ActionResult> {
  const parsed = replyIdSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid reply.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await approveReply({
          tx,
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          replyId: parsed.data.replyId,
        });
      },
      // Approval is the accountable signature; it is not a member's to give.
      { minimumRole: "admin" },
    );

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "approveReply failed");
    return toReplyResult(error);
  }
}

/**
 * Approve **and** post, in one press (A22-B5).
 *
 * The two-step exists for a real reason and it is not the owner's reason: a
 * member drafts, an admin signs off, and the signature is a distinct
 * accountable act. But an owner replying to their own café's one-star review is
 * both people, and the product made them press *Onayla* and then *Yanıtı
 * gönder* — two buttons for one intention, with a state in between that means
 * nothing to them and a real chance of stopping there. The tester did.
 *
 * So the two-step survives exactly where it means something — a member's draft
 * still needs an admin — and an admin gets one button. One action rather than
 * two calls from the browser, because "approved but not posted" is a state
 * nobody chose and a partial failure would leave the reader in it.
 */
export async function sendReplyAction(input: { replyId: string }): Promise<ActionResult> {
  const parsed = replyIdSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid reply.");

  try {
    const outcome = await withAuthenticatedTenant(
      async (tx, actor) => {
        const approved = await approveReply({
          tx,
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          replyId: parsed.data.replyId,
        });

        // Already approved by somebody else is not an error here: the intent is
        // "send this", and `approveReply` refuses a wrong status rather than
        // silently re-approving, so reaching this line means it is postable.
        void approved;

        return postReply({
          tx,
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          replyId: parsed.data.replyId,
        });
      },
      { minimumRole: "admin" },
    );

    revalidatePath("/", "layout");
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.reason };
  } catch (error) {
    log.warn({ err: error }, "sendReply failed");
    return toReplyResult(error);
  }
}

export async function postReplyAction(input: { replyId: string }): Promise<ActionResult> {
  const parsed = replyIdSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid reply.");

  try {
    // The rejection is returned rather than thrown, so that the `failed` row
    // and its reason survive the transaction — see the note on `postReply`.
    // That makes reporting it the caller's job.
    const outcome = await withAuthenticatedTenant(
      async (tx, actor) =>
        postReply({
          tx,
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          replyId: parsed.data.replyId,
        }),
      { minimumRole: "admin" },
    );

    revalidatePath("/", "layout");
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.reason };
  } catch (error) {
    log.warn({ err: error }, "postReply failed");
    return toReplyResult(error);
  }
}

export async function discardReplyAction(input: { replyId: string }): Promise<ActionResult> {
  const parsed = replyIdSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error, "Invalid reply.");

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await discardReply({
          tx,
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          replyId: parsed.data.replyId,
        });
      },
      { minimumRole: "member" },
    );

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "discardReply failed");
    return toReplyResult(error);
  }
}
