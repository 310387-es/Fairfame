import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createWhatsAppClient,
  normalizePhone,
  verifyWebhookSignature,
} from "@/connectors/whatsapp/client";
import { flattenWebhook, inboundText, webhookSchema } from "@/connectors/whatsapp/schemas";
import {
  DIGEST_TEMPLATE,
  REVIEW_REQUEST_TEMPLATE,
  pendingTemplates,
  renderTemplate,
  TEMPLATES,
} from "@/connectors/whatsapp/templates";
import { isOptOut } from "@/messaging/whatsapp-inbound";
import { RateLimitError } from "@/connectors/throttle";

/**
 * The WhatsApp connector against recorded payloads (P1b-T3).
 *
 * Fixture-tested only, and that is the honest limit of it: a WhatsApp Business
 * Account, a verified number and an approved template are all gated on the
 * company existing. What these tests can establish is that the client speaks the
 * documented contract, classifies Meta's errors usefully, and — the part that
 * would be dangerous to get wrong — verifies webhook signatures properly.
 */

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/whatsapp/${name}.json`, import.meta.url), "utf8"),
  );
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  return createWhatsAppClient({
    accessToken: "test-token",
    phoneNumberId: "106540352242922",
    fetchImpl,
  });
}

describe("templates", () => {
  it("fills variables positionally", () => {
    const { body } = renderTemplate(REVIEW_REQUEST_TEMPLATE, "tr", [
      "Mehmet",
      "Kadıköy Şubesi",
      "https://r.example/abc",
    ]);

    expect(body).toContain("Merhaba Mehmet");
    expect(body).toContain("Kadıköy Şubesi");
    expect(body).toContain("https://r.example/abc");
    expect(body).not.toContain("{{");
  });

  it("refuses a wrong number of variables", () => {
    // Meta answers a count mismatch with a generic 400, by which point the send
    // has already been attempted.
    expect(() => renderTemplate(REVIEW_REQUEST_TEMPLATE, "en", ["only one"])).toThrow(
      /expects 3 variables/,
    );
  });

  it("collapses newlines out of a parameter", () => {
    // WhatsApp rejects a parameter containing a newline, and a review excerpt
    // very often has one.
    const { parameters } = renderTemplate(DIGEST_TEMPLATE, "en", [
      "Kadıköy",
      "Waiting times\nwere the theme\n\nthis week",
      "https://app.example/home",
    ]);

    expect(parameters[1]).not.toContain("\n");
  });

  it("never conditions the review request on how good the visit was", () => {
    // Rating-gating is forbidden everywhere, including a channel where nobody
    // would notice it.
    for (const body of Object.values(REVIEW_REQUEST_TEMPLATE.body)) {
      expect(body).not.toMatch(/if you (?:were|are) (?:happy|satisfied)/i);
      expect(body).not.toMatch(/memnun kald[ıi]ysan[ıi]z/i);
    }

    expect(REVIEW_REQUEST_TEMPLATE.body.en).toMatch(/good or bad/i);
    expect(REVIEW_REQUEST_TEMPLATE.body.tr).toMatch(/olumsuz/i);
  });

  it("offers an opt-out in the review request, in both languages", () => {
    expect(REVIEW_REQUEST_TEMPLATE.body.en).toMatch(/STOP/);
    expect(REVIEW_REQUEST_TEMPLATE.body.tr).toMatch(/STOP/);
  });

  it("declares the review request as marketing, not utility", () => {
    // It is unsolicited and promotes the business. Declaring it UTILITY to
    // dodge the opt-in requirement is what gets a number banned.
    expect(REVIEW_REQUEST_TEMPLATE.category).toBe("MARKETING");
    expect(DIGEST_TEMPLATE.category).toBe("UTILITY");
  });

  it("reports every template as still needing approval", () => {
    // The go-live checklist. When this stops being true, T6 has work to record.
    expect(pendingTemplates()).toHaveLength(Object.keys(TEMPLATES).length);
  });
});

describe("sending", () => {
  it("posts a template in Meta's shape", async () => {
    const fetchImpl = vi.fn(async () => response(fixture("send-success")));
    const result = await client(fetchImpl).sendTemplate({
      to: "905321234567",
      template: REVIEW_REQUEST_TEMPLATE,
      locale: "tr",
      values: ["Mehmet", "Kadıköy", "https://r.example/abc"],
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(url).toContain("/106540352242922/messages");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
    expect(body.messaging_product).toBe("whatsapp");
    expect(body.type).toBe("template");
    expect(result.ok).toBe(true);
    expect(result.ok && result.messageId).toMatch(/^wamid\./);
  });

  it("turns off link previews on free text", async () => {
    const fetchImpl = vi.fn(async () => response(fixture("send-success")));
    await client(fetchImpl).sendText({ to: "905321234567", body: "https://r.example/abc" });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { text: { preview_url: boolean } };

    // The preview fetch would leak the recipient's activity, and a card in a
    // support reply is noise.
    expect(body.text.preview_url).toBe(false);
  });

  it("classifies an unapproved template as permanent", async () => {
    const fetchImpl = async () => response(fixture("error-template"), 400);
    const result = await client(fetchImpl).sendText({ to: "905321234567", body: "hi" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.kind).toBe("template");
    // It will fail identically forever; retrying wastes the number's quality
    // rating as well as our time.
    expect(result.ok === false && result.retryable).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/not approved yet/);
  });

  it("raises a rate limit as the shared throttle error", async () => {
    const fetchImpl = async () => response(fixture("error-rate-limit"), 400);

    // Surfaced as RateLimitError so the connector backoff handles WhatsApp the
    // same way it handles every other provider.
    await expect(client(fetchImpl).sendText({ to: "905321234567", body: "hi" })).rejects.toThrow(
      RateLimitError,
    );
  });

  it("treats a transport failure as retryable", async () => {
    const fetchImpl = async () => {
      throw new Error("socket hang up");
    };

    const result = await client(fetchImpl).sendText({ to: "905321234567", body: "hi" });
    expect(result.ok === false && result.retryable).toBe(true);
  });

  it("refuses a success that carries no message id", async () => {
    const fetchImpl = async () => response({ messaging_product: "whatsapp", messages: [] });
    const result = await client(fetchImpl).sendText({ to: "905321234567", body: "hi" });

    // Recording a send that may not have happened is worse than reporting a
    // failure that did.
    expect(result.ok).toBe(false);
  });
});

describe("phone numbers", () => {
  it("adds the country code to a local Turkish number", () => {
    // Leaving it off silently sends to whatever country the WABA is in.
    expect(normalizePhone("0532 123 45 67")).toBe("905321234567");
  });

  it("keeps an already-international number", () => {
    expect(normalizePhone("+90 532 123 45 67")).toBe("905321234567");
  });

  it("rejects something that is not a phone number", () => {
    expect(normalizePhone("12")).toBeNull();
    expect(normalizePhone("not a number")).toBeNull();
  });
});

describe("webhook signatures", () => {
  const secret = "app-secret";
  const body = JSON.stringify({ hello: "world" });
  const valid = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

  it("accepts a correct signature", () => {
    expect(verifyWebhookSignature({ rawBody: body, header: valid, appSecret: secret })).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyWebhookSignature({ rawBody: `${body} `, header: valid, appSecret: secret })).toBe(
      false,
    );
  });

  it("rejects the wrong secret", () => {
    expect(verifyWebhookSignature({ rawBody: body, header: valid, appSecret: "other" })).toBe(
      false,
    );
  });

  it("rejects a missing or malformed header", () => {
    expect(verifyWebhookSignature({ rawBody: body, header: null, appSecret: secret })).toBe(false);
    expect(verifyWebhookSignature({ rawBody: body, header: "deadbeef", appSecret: secret })).toBe(
      false,
    );
  });

  it("rejects a short signature without throwing", () => {
    // timingSafeEqual throws on a length mismatch; letting that escape would
    // turn a forgery attempt into a 500.
    expect(() =>
      verifyWebhookSignature({ rawBody: body, header: "sha256=ab", appSecret: secret }),
    ).not.toThrow();
  });
});

describe("webhook payloads", () => {
  it("flattens Meta's four levels of nesting", () => {
    const parsed = webhookSchema.parse(fixture("inbound-text"));
    const events = flattenWebhook(parsed);

    expect(events.phoneNumberId).toBe("106540352242922");
    expect(events.messages).toHaveLength(1);
    expect(events.messages[0]?.profileName).toBe("Mehmet");
    expect(inboundText(events.messages[0]!.message)).toBe("Merhaba, dün akşam gelmiştik");
  });

  it("reads a delivery status", () => {
    const events = flattenWebhook(webhookSchema.parse(fixture("status-delivered")));

    expect(events.messages).toHaveLength(0);
    expect(events.statuses[0]?.status).toBe("delivered");
  });

  it("accepts a message type it does not model", () => {
    // Meta retries a non-2xx and eventually disables the endpoint, so a sticker
    // must not fail a delivery.
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  { from: "905321234567", id: "wamid.x", timestamp: "1", type: "sticker" },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = flattenWebhook(webhookSchema.parse(payload));
    expect(events.messages).toHaveLength(1);
    expect(inboundText(events.messages[0]!.message)).toBeNull();
  });

  it("tolerates fields Meta adds later", () => {
    const payload = fixture("inbound-text") as Record<string, unknown>;
    (payload as { some_new_field?: string }).some_new_field = "added in v22";

    // A schema that rejected an unknown key would turn a platform change into
    // an outage.
    expect(() => webhookSchema.parse(payload)).not.toThrow();
  });
});

describe("opt-out detection", () => {
  it("recognises the word on its own, in both languages", () => {
    for (const word of ["STOP", "stop", "Dur", "iptal", "ÇIK", "unsubscribe"]) {
      expect(isOptOut(word)).toBe(true);
    }
  });

  it("ignores the word inside a sentence", () => {
    // Unsubscribing someone who did not ask is its own kind of failure.
    expect(isOptOut("the service was a total stop-start mess")).toBe(false);
    expect(isOptOut("Dur bakalım, güzeldi aslında")).toBe(false);
  });

  it("ignores an empty message", () => {
    expect(isOptOut(null)).toBe(false);
    expect(isOptOut("   ")).toBe(false);
  });
});
