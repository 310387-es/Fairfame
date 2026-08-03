import { NextResponse } from "next/server";
import { flattenWebhook, webhookSchema } from "@/connectors/instagram/schemas";
import { verifyWebhookSignature } from "@/connectors/whatsapp/client";
import { getEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import { requestInstagramSync } from "@/messaging/instagram-inbound";

/**
 * Meta's webhook for Instagram (P1b-T4).
 *
 * The same shape as the WhatsApp endpoint, and it reuses the same signature
 * verifier — both are Meta apps signing with the same app secret over the raw
 * body, so a second implementation would be a second place to get constant-time
 * comparison wrong.
 *
 * **A webhook is treated as a signal, not as data.** Meta's own guidance is that
 * the fields on a change event vary by permission and object type, so rather
 * than trusting the payload's `text`, this enqueues a sync and lets the
 * connector re-read through the Graph API. That also means a replayed event —
 * were the signature ever bypassed — could at worst cause a redundant read,
 * never an injected comment.
 *
 * Fixture-tested only: the permissions come through Meta app review.
 */

const log = childLogger({ module: "webhooks/instagram" });

export async function GET(request: Request): Promise<Response> {
  const env = getEnv();
  const url = new URL(request.url);

  if (!env.INSTAGRAM_VERIFY_TOKEN) {
    log.warn("Instagram webhook verification attempted with no verify token configured");
    return new NextResponse("not configured", { status: 503 });
  }

  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");

  if (mode !== "subscribe" || token !== env.INSTAGRAM_VERIFY_TOKEN) {
    return new NextResponse("forbidden", { status: 403 });
  }

  return new NextResponse(url.searchParams.get("hub.challenge") ?? "", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const env = getEnv();

  if (!env.META_APP_SECRET) {
    log.error("Instagram webhook received with no app secret configured; rejecting");
    return new NextResponse("not configured", { status: 503 });
  }

  const rawBody = await request.text();

  const verified = verifyWebhookSignature({
    rawBody,
    header: request.headers.get("x-hub-signature-256"),
    appSecret: env.META_APP_SECRET,
  });

  if (!verified) {
    log.warn("Rejected an Instagram webhook with an invalid signature");
    return new NextResponse("invalid signature", { status: 403 });
  }

  try {
    const parsed = webhookSchema.safeParse(JSON.parse(rawBody));

    if (parsed.success) {
      const signals = flattenWebhook(parsed.data);
      const queued = await requestInstagramSync(signals);

      log.info({ signals: signals.length, queued }, "Instagram webhook processed");
    } else {
      log.warn({ issues: parsed.error.issues.length }, "Unrecognised Instagram webhook shape");
    }
  } catch (error) {
    // Still a 200: Meta retries a non-2xx and eventually disables the
    // subscription, and a failure on our side is not something a retry fixes.
    log.error({ err: error }, "Failed to process an Instagram webhook");
  }

  return NextResponse.json({ received: true });
}
