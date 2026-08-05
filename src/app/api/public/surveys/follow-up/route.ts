import { NextResponse } from "next/server";
import { z } from "zod";
import { childLogger } from "@/lib/logger";
import { recordFollowUp } from "@/surveys/public";

/**
 * The private follow-up a detractor is offered after answering (P4-T2).
 *
 * Its own endpoint rather than a second field on the answer, because it happens
 * at a different moment and lands in a different column under a different
 * promise: `follow_up_comment` answers "what went wrong, and may we put it
 * right", and is never a candidate for public display anywhere.
 *
 * **This is the compliant half of the detractor flow.** What `docs/20` forbids
 * is routing unhappy customers *away from a public review*; what it explicitly
 * permits is exactly this — a private resolution path. So the box appears in
 * addition to whatever review invitation the survey offers, never instead of
 * it. `src/surveys/outcome.ts` is where that is enforced, and it is enforced by
 * the invitation not being computable from the score.
 */

const log = childLogger({ module: "api/public/surveys/follow-up" });

const bodySchema = z.object({
  token: z.string().trim().min(1).max(64),
  comment: z.string().trim().min(1).max(2_000),
});

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
    const result = await recordFollowUp(parsed.data.token, parsed.data.comment);

    // One status for "no such token" and "that token has not answered yet":
    // distinguishing them would confirm a token exists.
    if (!result.ok) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error({ err: error }, "Survey follow-up failed");
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
