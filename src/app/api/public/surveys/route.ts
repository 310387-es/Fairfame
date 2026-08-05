import { NextResponse } from "next/server";
import { z } from "zod";
import { childLogger } from "@/lib/logger";
import { recordAnswer, type AnswerFailure } from "@/surveys/public";

/**
 * The public survey answer endpoint (P4-T2).
 *
 * The second unauthenticated write path in the product, and it follows the
 * rules the first one set (`/api/public/reviews`): it accepts a **token or a
 * slug**, never an organization id, so the tenant is whatever the code resolves
 * to and a caller cannot aim an answer at an organization of their choosing.
 * Same-origin only — no CORS headers — because the only legitimate caller is our
 * own hosted page.
 *
 * The score is validated against the survey's own scale inside `recordAnswer`,
 * not here: which numbers are legal depends on whether this is an NPS or a
 * CSAT, and that is not knowable until the code has been resolved.
 */

const log = childLogger({ module: "api/public/surveys" });

const STATUS: Record<AnswerFailure, number> = {
  not_found: 404,
  closed: 410,
  invalid_score: 400,
  already_answered: 409,
  rate_limited: 429,
};

const bodySchema = z
  .object({
    token: z.string().trim().max(64).optional(),
    slug: z.string().trim().max(64).optional(),
    score: z.number().int().min(0).max(10),
    comment: z.string().trim().max(2_000).optional(),
  })
  .refine((value) => Boolean(value.token || value.slug), {
    message: "A survey token or slug is required.",
  });

/**
 * Best guess at the caller's address, for rate limiting only.
 *
 * Proxy headers are forgeable, so this is not an authentication signal — it
 * raises the cost of automated abuse and nothing more.
 */
function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip");
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  try {
    const result = await recordAnswer(parsed.data, { ip: clientIp(request) });

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: STATUS[result.error] });
    }

    // The token comes back because the outcome screen — including a detractor's
    // private follow-up — is addressed by it. For a walk-in answer it is the
    // token just minted, which is the only way that person can add anything.
    return NextResponse.json({ ok: true, token: result.token, score: result.score });
  } catch (error) {
    log.error({ err: error }, "Survey answer failed");
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
