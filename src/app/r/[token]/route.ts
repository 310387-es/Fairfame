import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { markRequestOpened, resolveRequestByToken } from "@/collect/public";
import { resolveDestination } from "@/collect/routing";
import { publicBaseUrl } from "@/lib/urls";

/**
 * The tracked short link from a review request: /r/{token}.
 *
 * A route handler rather than a page, because opening the link has a side
 * effect — it advances the funnel — and a server component that mutated on
 * render would fire on every prefetch and re-render.
 *
 * The order matters: record the open, then redirect. If the tracking write
 * fails it is swallowed (see markRequestOpened) and the customer still lands
 * where they were going. Analytics never gets to break the product.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  const request = await resolveRequestByToken(token);

  // An unknown token gets the generic 404. Saying "this link was already used"
  // would confirm the token existed.
  if (!request) notFound();

  await markRequestOpened(request.campaign.organizationId, request.requestId);

  // Routing is read from the campaign alone — the customer's rating does not
  // exist yet, and could not influence this even if it did. See collect/routing.
  const route = resolveDestination(request.campaign, publicBaseUrl());

  const target =
    route.kind === "firstparty"
      ? // Carry the token so the submission can be attributed to this ask.
        `${route.url}?rt=${encodeURIComponent(token)}`
      : route.url;

  // 302, not 301: a permanent redirect would be cached by the customer's
  // browser and every later open would go untracked.
  return NextResponse.redirect(target, 302);
}
