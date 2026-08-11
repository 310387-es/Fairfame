import { describe, expect, it } from "vitest";
import {
  firstPartyCapabilities,
  firstPartyConnector,
  FIRST_PARTY_PROVIDER,
  toRawReview,
  type FirstPartyPayload,
} from "@/connectors/firstparty";
import { getConnector, hasConnector, listProviders } from "@/connectors/registry";
import { ConnectorError, type Connection } from "@/connectors/types";
import {
  createCampaignSchema,
  KVKK_NOTICE_VERSION,
  parseRecipientList,
  publicSubmissionSchema,
} from "@/collect/input";
import { resolveDestination } from "@/collect/routing";
import {
  generateCampaignSlug,
  looksLikeSlug,
  looksLikeToken,
  REQUEST_TOKEN_LENGTH,
  slugifyName,
} from "@/collect/tokens";
import { randomCode } from "@/lib/codes";
import { createCaptureTransport, createLogTransport } from "@/messaging/email";
import { renderReviewRequestEmail } from "@/messaging/templates";
import { buildCampaignUrl, buildRequestUrl, buildUnsubscribeUrl } from "@/lib/urls";

/**
 * P1b-T1 unit surface: everything in first-party collection that can be
 * decided without a database.
 *
 * The compliance invariants get first-class tests rather than a comment,
 * because "no rating-gating" and "every message carries an opt-out" are
 * product requirements (docs/02-prd.md R2) that a well-meaning refactor could
 * quietly undo.
 */

const LOCATION_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN_ID = "44444444-4444-4444-8444-444444444444";
const SUBMISSION_ID = "55555555-5555-4555-8555-555555555555";

function connection(): Connection {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organizationId: ORG_ID,
    locationId: LOCATION_ID,
    provider: FIRST_PARTY_PROVIDER,
    status: "active",
    capabilities: firstPartyCapabilities,
    config: { locationId: LOCATION_ID },
    encryptedTokens: null,
    cursor: null,
    lastSyncedAt: null,
    firstSyncedAt: null,
    nextSyncAt: null,
    failureCount: 0,
    createdAt: new Date("2026-08-01T00:00:00Z"),
  };
}

function payload(overrides: Partial<FirstPartyPayload> = {}): FirstPartyPayload {
  return {
    submissionId: SUBMISSION_ID,
    rating: 5,
    comment: "Kahve harikaydı, personel çok ilgiliydi.",
    authorName: "Ayşe",
    language: "tr",
    submittedAt: "2026-08-02T10:00:00.000Z",
    campaign: { id: CAMPAIGN_ID, slug: "kadikoy-h7m2qp", channel: "email" },
    requestId: null,
    contactId: null,
    kvkkNotice: {
      version: KVKK_NOTICE_VERSION,
      shownAt: "2026-08-02T10:00:00.000Z",
      accepted: false,
    },
    ...overrides,
  };
}

describe("codes in public URLs", () => {
  it("draws only from the unambiguous alphabet", () => {
    // i, l, o, 0 and 1 are excluded: these get transcribed off printed pages.
    expect(randomCode(400)).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]+$/);
  });

  it("produces the requested length", () => {
    for (const length of [1, 6, 22, 64]) {
      expect(randomCode(length)).toHaveLength(length);
    }
  });

  it("does not repeat itself", () => {
    const drawn = new Set(Array.from({ length: 200 }, () => randomCode(REQUEST_TOKEN_LENGTH)));
    expect(drawn.size).toBe(200);
  });

  it("transliterates Turkish characters into a readable slug", () => {
    expect(slugifyName("Kadıköy Şubesi")).toBe("kadikoy-subesi");
    expect(slugifyName("Çiğköfteci Ömer")).toBe("cigkofteci-omer");
    expect(slugifyName("  ")).toBe("");
  });

  it("builds a slug from the campaign name plus a suffix", () => {
    const slug = generateCampaignSlug("Ziyaret sonrası");
    expect(slug).toMatch(/^ziyaret-sonrasi-[a-z0-9]{6}$/);
    expect(looksLikeSlug(slug)).toBe(true);
  });

  it("still produces a slug when the name transliterates to nothing", () => {
    expect(generateCampaignSlug("日本語")).toMatch(/^[a-z0-9]{6}$/);
  });

  it("recognises only well-formed tokens", () => {
    expect(looksLikeToken(randomCode(REQUEST_TOKEN_LENGTH))).toBe(true);
    expect(looksLikeToken("too-short")).toBe(false);
    // Excluded letters must not pass — they never appear in a real token.
    expect(looksLikeToken("l".repeat(REQUEST_TOKEN_LENGTH))).toBe(false);
  });
});

describe("campaign input", () => {
  it("accepts a first-party campaign with no destination URL", () => {
    const result = createCampaignSchema.safeParse({
      locationId: LOCATION_ID,
      name: "After a visit",
    });
    expect(result.success).toBe(true);
    expect(result.data?.destination).toBe("firstparty");
    expect(result.data?.channel).toBe("email");
  });

  it("requires a URL for an external campaign", () => {
    const result = createCampaignSchema.safeParse({
      locationId: LOCATION_ID,
      name: "Google",
      destination: "external",
    });
    expect(result.success).toBe(false);
  });

  it("refuses a non-http destination", () => {
    // A javascript: URL emailed to customers is a phishing vector, not a typo.
    for (const url of ["javascript:alert(1)", "ftp://example.com", "data:text/html,x"]) {
      const result = createCampaignSchema.safeParse({
        locationId: LOCATION_ID,
        name: "Bad",
        destination: "external",
        destinationUrl: url,
      });
      expect(result.success, url).toBe(false);
    }
  });

  it("accepts sms and whatsapp, which route through the consent gate (W2.2)", () => {
    // These were refused here until review requests learned to send through
    // `sendMessage`. The refusal has not gone away — it has moved to where it
    // belongs: a message on either channel is still stopped, by the gate, with
    // a named reason, at the moment it would leave. A schema that rejected the
    // *campaign* meant a business could not even describe the thing it wanted
    // to do once the credentials arrived.
    for (const channel of ["sms", "whatsapp"]) {
      const result = createCampaignSchema.safeParse({
        locationId: LOCATION_ID,
        name: "Now describable",
        channel,
      });
      expect(result.success, channel).toBe(true);
    }
  });

  it("still refuses a channel that does not exist", () => {
    const result = createCampaignSchema.safeParse({
      locationId: LOCATION_ID,
      name: "Carrier pigeon",
      channel: "pigeon",
    });

    expect(result.success).toBe(false);
  });
});

/**
 * A22-B3 — an empty name has to come back as an answer.
 *
 * The form carried a native `required`, which blocks the submit before the
 * action runs: pressing the button on an empty name moved focus and said
 * nothing at all. The attribute is `aria-required` now, so the schema is what
 * refuses — and a refusal is only useful if it names the field, because that is
 * what puts the sentence under the right control and the cursor in it.
 */
describe("the campaign form's own validation", () => {
  it("refuses an empty name, against the field", () => {
    const parsed = createCampaignSchema.safeParse({
      locationId: "0b3ff2e0-0d59-4c1e-8f2a-2c0f2a0c4b11",
      name: "",
    });

    if (parsed.success) throw new Error("expected a failure");
    expect(parsed.error.issues.map((issue) => issue.path[0])).toContain("name");
  });

  it("refuses whitespace, which is what a stray keystroke leaves", () => {
    const parsed = createCampaignSchema.safeParse({
      locationId: "0b3ff2e0-0d59-4c1e-8f2a-2c0f2a0c4b11",
      name: "   ",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("recipient parsing", () => {
  it("reads newline, comma and semicolon separated lists", () => {
    const { recipients, invalid } = parseRecipientList(
      "ayse@example.com\nmehmet@example.com, zeynep@example.com; can@example.com",
    );
    expect(recipients.map((r) => r.email)).toEqual([
      "ayse@example.com",
      "mehmet@example.com",
      "zeynep@example.com",
      "can@example.com",
    ]);
    expect(invalid).toEqual([]);
  });

  it("understands the Name <email> form pasted out of a mail client", () => {
    const { recipients } = parseRecipientList('"Ayşe Yılmaz" <ayse@example.com>');
    expect(recipients[0]).toEqual({ email: "ayse@example.com", name: "Ayşe Yılmaz" });
  });

  it("reports invalid addresses instead of dropping them", () => {
    const { recipients, invalid } = parseRecipientList("good@example.com, not-an-email");
    expect(recipients).toHaveLength(1);
    // Silently skipping would leave the owner believing they asked someone.
    expect(invalid).toEqual(["not-an-email"]);
  });

  it("asks nobody twice in one send", () => {
    const { recipients } = parseRecipientList("a@example.com, A@Example.com, a@example.com");
    expect(recipients).toHaveLength(1);
  });
});

describe("public submission input", () => {
  it("accepts an anonymous rating with no contact details", () => {
    const result = publicSubmissionSchema.safeParse({ slug: "abc", rating: 3 });
    expect(result.success).toBe(true);
    expect(result.data?.comment).toBe("");
    expect(result.data?.email).toBeNull();
  });

  it("requires the KVKK acknowledgement once an email is given", () => {
    const base = { slug: "abc", rating: 5, email: "someone@example.com" };
    expect(publicSubmissionSchema.safeParse(base).success).toBe(false);
    expect(publicSubmissionSchema.safeParse({ ...base, kvkkAccepted: true }).success).toBe(true);
  });

  it("bounds the rating and coerces the form's string", () => {
    expect(publicSubmissionSchema.safeParse({ slug: "abc", rating: "4" }).data?.rating).toBe(4);
    expect(publicSubmissionSchema.safeParse({ slug: "abc", rating: 0 }).success).toBe(false);
    expect(publicSubmissionSchema.safeParse({ slug: "abc", rating: 6 }).success).toBe(false);
  });

  it("caps the comment length", () => {
    const result = publicSubmissionSchema.safeParse({
      slug: "abc",
      rating: 5,
      comment: "x".repeat(5_001),
    });
    expect(result.success).toBe(false);
  });
});

describe("destination routing (no rating-gating)", () => {
  const base = "https://app.fairfame.test";

  it("sends a first-party campaign to our own page", () => {
    expect(
      resolveDestination(
        { slug: "kadikoy-h7m2qp", destination: "firstparty", destinationUrl: null },
        base,
      ),
    ).toEqual({ kind: "firstparty", url: "https://app.fairfame.test/c/kadikoy-h7m2qp" });
  });

  it("sends an external campaign to the platform", () => {
    expect(
      resolveDestination(
        { slug: "s", destination: "external", destinationUrl: "https://g.page/r/x" },
        base,
      ),
    ).toEqual({ kind: "external", url: "https://g.page/r/x" });
  });

  it("falls back to our page when an external campaign has no URL", () => {
    expect(
      resolveDestination({ slug: "s", destination: "external", destinationUrl: null }, base).kind,
    ).toBe("firstparty");
  });

  /**
   * The structural guarantee: routing takes (campaign, baseUrl) and nothing
   * else. Gating on rating would require a third parameter, and this assertion
   * is what makes that impossible to add quietly.
   */
  it("cannot see a rating, because it is never passed one", () => {
    expect(resolveDestination.length).toBe(2);
  });
});

describe("review request email", () => {
  const input = {
    locale: "tr" as const,
    contactName: "Ayşe",
    businessName: "Kahve Dünyası",
    locationName: "Kadıköy Şubesi",
    link: "https://app.fairfame.test/r/abcdefghjkmnpqrstuvwx",
    unsubscribeUrl: "https://app.fairfame.test/u/abcdefghjkmnpqrstuvwx",
  };

  it("renders Turkish for a Turkish recipient", () => {
    const email = renderReviewRequestEmail(input);
    expect(email.subject).toContain("Kadıköy Şubesi");
    expect(email.text).toContain("Merhaba Ayşe,");
    expect(email.text).toContain(input.link);
  });

  it("renders English for an English recipient", () => {
    const email = renderReviewRequestEmail({ ...input, locale: "en" });
    expect(email.subject).toBe("How was your visit to Kadıköy Şubesi?");
    expect(email.text).toContain("Hi Ayşe,");
  });

  it("greets a recipient whose name we never learned", () => {
    expect(renderReviewRequestEmail({ ...input, contactName: null }).text).toContain("Merhaba,");
  });

  it("always carries the reason for receipt and an opt-out link", () => {
    for (const locale of ["tr", "en"] as const) {
      const email = renderReviewRequestEmail({ ...input, locale });
      expect(email.text).toContain(input.unsubscribeUrl);
      expect(email.html).toContain(input.unsubscribeUrl);
      expect(email.text).toContain("Kahve Dünyası");
    }
  });

  it("keeps the opt-out even when the owner supplies their own copy", () => {
    // Overrides replace the message, never the compliance footer.
    const email = renderReviewRequestEmail({
      ...input,
      overrides: { subject: "Bize bir yorum bırakır mısınız?", body: "Kendi metnimiz." },
    });
    expect(email.subject).toBe("Bize bir yorum bırakır mısınız?");
    expect(email.text).toContain("Kendi metnimiz.");
    expect(email.text).toContain(input.unsubscribeUrl);
  });

  it("escapes user-supplied text in the HTML part", () => {
    const email = renderReviewRequestEmail({
      ...input,
      businessName: '<script>alert("x")</script>',
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});

describe("email transports", () => {
  it("captures what it was asked to send", async () => {
    const transport = createCaptureTransport();
    const result = await transport.send({
      to: "a@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    });

    expect(result.ok).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe("a@example.com");
  });

  it("reports success from the log transport without sending anything", async () => {
    const result = await createLogTransport().send({
      to: "a@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    });
    expect(result).toEqual({ ok: true, messageId: null });
  });
});

describe("public link builders", () => {
  it("never doubles a slash on a base URL that ends in one", () => {
    expect(buildCampaignUrl("https://x.test/", "abc")).toBe("https://x.test/c/abc");
    expect(buildRequestUrl("https://x.test//", "tok")).toBe("https://x.test/r/tok");
    expect(buildUnsubscribeUrl("https://x.test", "tok")).toBe("https://x.test/u/tok");
  });
});

describe("the first-party connector", () => {
  it("is registered alongside the mock", () => {
    expect(hasConnector(FIRST_PARTY_PROVIDER)).toBe(true);
    expect(getConnector(FIRST_PARTY_PROVIDER).provider).toBe(FIRST_PARTY_PROVIDER);
    expect(listProviders()).toContain(FIRST_PARTY_PROVIDER);
  });

  it("declares a readable, realtime source with no reply channel", () => {
    expect(firstPartyCapabilities).toEqual({ read: "full", reply: "none", realtime: true });
    // The contract says postReply exists only when reply === "api".
    expect(firstPartyConnector.postReply).toBeUndefined();
  });

  it("has nothing to poll, because submissions are pushed to it", async () => {
    expect(await firstPartyConnector.fetchReviews(connection())).toEqual([]);
  });

  it("normalizes a submission into the canonical shape", () => {
    const review = firstPartyConnector.normalize(connection(), toRawReview(payload()));

    expect(review).toMatchObject({
      locationId: LOCATION_ID,
      source: FIRST_PARTY_PROVIDER,
      sourceReviewId: SUBMISSION_ID,
      authorName: "Ayşe",
      rating: 5,
      language: "tr",
      url: null,
    });
    expect(review.postedAt?.toISOString()).toBe("2026-08-02T10:00:00.000Z");
    // The provider payload is retained verbatim, always.
    expect(review.rawPayload).toMatchObject({ campaign: { slug: "kadikoy-h7m2qp" } });
  });

  it("stores a rating with no words as null text, not an empty string", () => {
    const review = firstPartyConnector.normalize(
      connection(),
      toRawReview(payload({ comment: "   " })),
    );
    expect(review.text).toBeNull();
  });

  it("keeps no contact details in the payload — only a contact id", () => {
    const raw = toRawReview(payload({ contactId: ORG_ID }));
    // KVKK erasure deletes one contact row; it must not have to rewrite jsonb.
    expect(JSON.stringify(raw.payload)).not.toContain("@");
  });

  it("refuses a payload it cannot validate, permanently", () => {
    const raw = { sourceReviewId: "x", payload: { rating: 9 } };
    expect(() => firstPartyConnector.normalize(connection(), raw)).toThrow(ConnectorError);

    try {
      firstPartyConnector.normalize(connection(), raw);
    } catch (error) {
      // A malformed payload will not become valid on the fifth attempt.
      expect((error as ConnectorError).retryable).toBe(false);
    }
  });

  it("takes the location from the connection, never from the payload", () => {
    const review = firstPartyConnector.normalize(connection(), toRawReview(payload()));
    expect(review.locationId).toBe(LOCATION_ID);
  });

  it("rejects a config without a location", async () => {
    await expect(firstPartyConnector.connect(ORG_ID, {})).rejects.toThrow(ConnectorError);
  });
});
