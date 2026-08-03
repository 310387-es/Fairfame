import { NextResponse } from "next/server";
import { publicSubmissionSchema } from "@/collect/input";
import { submitReview, type SubmitFailure } from "@/collect/submissions";
import { childLogger } from "@/lib/logger";

/**
 * The public review submission endpoint.
 *
 * The one unauthenticated write path in the product. It accepts a campaign
 * slug, not an organization id — the tenant is whatever that slug resolves to,
 * so a caller cannot aim a submission at an organization of their choosing.
 *
 * Deliberately same-origin only: no CORS headers are set, because the only
 * legitimate caller is our own hosted page. A kiosk or embedded widget on a
 * customer's domain is a Phase 3 concern and will need a considered origin
 * policy rather than an accidental one.
 */

const log = childLogger({ module: "api/public/reviews" });

/** Failure → HTTP status. Nothing here reveals whether a slug exists elsewhere. */
const STATUS: Record<SubmitFailure, number> = {
  not_found: 404,
  closed: 410,
  rate_limited: 429,
  already_submitted: 409,
  wrong_campaign: 400,
};

/**
 * Best guess at the caller's address for rate limiting.
 *
 * Proxy headers are forgeable, so this is not an authentication signal — it
 * raises the cost of automated abuse and nothing more. `x-forwarded-for` may
 * carry a chain; the first entry is the client as the nearest trusted proxy
 * saw it.
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

  const parsed = publicSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    const result = await submitReview(parsed.data, { ip: clientIp(request) });

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: STATUS[result.error] });
    }

    return NextResponse.json({ ok: true, reviewId: result.reviewId }, { status: 201 });
  } catch (error) {
    // The customer sees a generic failure; the detail goes to the logs. A
    // stack trace on a public endpoint is a gift to whoever is probing it.
    log.error({ slug: parsed.data.slug, err: error }, "Public submission failed");
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
