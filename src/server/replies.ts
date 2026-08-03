"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuthenticatedTenant } from "@/auth/session";
import { childLogger } from "@/lib/logger";
import { MAX_REPLY_CHARS } from "@/prompts/index";
import {
  approveReply,
  discardReply,
  draftReplyForReview,
  postReply,
  ReplyError,
  saveReplyDraft,
  writeReplyDraft,
} from "@/replies/service";
import { toActionResult, type ActionResult } from "@/server/action-result";

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

const reviewIdSchema = z.object({ reviewId: z.uuid() });
const replyIdSchema = z.object({ replyId: z.uuid() });
const saveSchema = z.object({
  replyId: z.uuid(),
  text: z.string().trim().min(1).max(MAX_REPLY_CHARS),
});

/** Maps a domain failure to something worth showing a person. */
function toReplyResult(error: unknown): ActionResult {
  if (error instanceof ReplyError) return { ok: false, error: error.message };
  return toActionResult(error);
}

export async function draftReplyAction(input: { reviewId: string }): Promise<ActionResult> {
  const parsed = reviewIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid review." };

  try {
    await withAuthenticatedTenant(
      async (tx, actor) => {
        await draftReplyForReview({
          tx,
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          reviewId: parsed.data.reviewId,
        });
      },
      { minimumRole: "member" },
    );

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    log.warn({ err: error }, "draftReply failed");
    return toReplyResult(error);
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
  if (!parsed.success) return { ok: false, error: "Write something first." };

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
    return {
      ok: false,
      error: `A reply must be between 1 and ${MAX_REPLY_CHARS} characters.`,
    };
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
  if (!parsed.success) return { ok: false, error: "Invalid reply." };

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

export async function postReplyAction(input: { replyId: string }): Promise<ActionResult> {
  const parsed = replyIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid reply." };

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
  if (!parsed.success) return { ok: false, error: "Invalid reply." };

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
