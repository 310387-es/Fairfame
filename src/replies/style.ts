/**
 * How a drafted reply should sound, and how it is signed (W4 fold-in, W5-12).
 *
 * Deliberately its own module with **no imports at all**. The composer is a
 * `"use client"` component and renders these lists as controls; the prompt
 * builder consumes the same values on the server. A shared constant is the only
 * way those two cannot drift, and the codebase's rule is that such a constant
 * lives in a module that cannot reach the database (see
 * `src/replies/template-vars.ts`, which exists for the same reason).
 *
 * ## Tone is not brand voice
 *
 * `locations.brand_tone` is how a *business* talks — "warm and informal", set
 * once and true of every reply that branch sends. What is here is the stance
 * taken toward *one review*: this particular customer is owed an apology, or a
 * thank-you, or the short formal acknowledgement a legal complaint gets. The two
 * compose rather than compete, which is why `draftReplyPrompt` takes both and
 * why picking a tone here does not overwrite anything the owner configured.
 *
 * `"default"` adds nothing to the prompt. That is the point of having it in the
 * list: the absence of a stance is a choice a person can make and see, rather
 * than a fifth option that quietly means "warm".
 */

/** The stances a draft may be asked to take. A closed list, not free text. */
export const REPLY_TONES = ["default", "warm", "formal", "apologetic", "appreciative"] as const;
export type ReplyTone = (typeof REPLY_TONES)[number];

/** How long the draft should be. */
export const REPLY_LENGTHS = ["short", "standard", "long"] as const;
export type ReplyLength = (typeof REPLY_LENGTHS)[number];

export type ReplyStyle = { tone: ReplyTone; length: ReplyLength };

export const DEFAULT_REPLY_STYLE: ReplyStyle = { tone: "default", length: "standard" };

/**
 * Character targets per length.
 *
 * A *target*, not a limit — `MAX_REPLY_CHARS` is the limit and `boundOutput`
 * still enforces it after generation. Models treat a character count as a
 * suggestion, so these are chosen far enough apart that missing one by a third
 * still lands in a visibly different band: two sentences, a paragraph, or the
 * full answer a detailed complaint deserves.
 */
export const REPLY_LENGTH_TARGETS: Record<ReplyLength, number> = {
  short: 220,
  standard: 480,
  long: 880,
};

/** The instruction line for each stance. Empty for `default` — see above. */
const TONE_INSTRUCTIONS: Record<ReplyTone, string> = {
  default: "",
  warm: "Sound warm and personal, as if the owner is speaking.",
  formal: "Keep it formal and restrained. No familiarity, no exclamation marks.",
  apologetic:
    "Lead with an apology for what went wrong, take responsibility without excuses, and say what happens next.",
  appreciative: "Lead with genuine thanks for the specific thing they praised.",
};

/**
 * Builds the two style lines a draft prompt carries.
 *
 * Returns an array so the caller can drop it into an instruction list without
 * having to think about spacing, and so `default` contributes nothing rather
 * than an empty sentence.
 */
export function styleInstructions(style: ReplyStyle): string[] {
  const lines: string[] = [];
  const tone = TONE_INSTRUCTIONS[style.tone];
  if (tone) lines.push(tone);
  lines.push(`Aim for about ${REPLY_LENGTH_TARGETS[style.length]} characters.`);
  return lines;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * Ceiling on a branch's reply signature.
 *
 * Short on purpose. A signature is a name and a role — "Ayşe, Kadıköy Şubesi" —
 * and the moment it can hold a paragraph somebody puts their opening hours and
 * a discount code in it, which then goes out on the end of an apology.
 */
export const MAX_SIGNATURE_CHARS = 120;

/**
 * Appends a branch's signature to a reply, once.
 *
 * **Idempotent, and that is the whole reason this is a function.** Regenerating
 * a draft replaces the text but the composer may already be holding a signed
 * version; a template body may end with the signature already; somebody may
 * press "Add signature" twice. Every one of those produces a reply signed twice
 * if the append is a bare concatenation, and nobody notices until a customer
 * sees it.
 *
 * The model is never asked to write the signature — `DRAFT_SYSTEM` explicitly
 * forbids a signature block. A generated sign-off is a generated *name*, and a
 * name is exactly the thing a reply must not invent.
 */
export function appendSignature(text: string, signature: string | null | undefined): string {
  const trimmedSignature = (signature ?? "").trim();
  if (trimmedSignature.length === 0) return text;

  const body = text.trimEnd();
  if (body.endsWith(trimmedSignature)) return body;

  return body.length === 0 ? trimmedSignature : `${body}\n\n${trimmedSignature}`;
}
