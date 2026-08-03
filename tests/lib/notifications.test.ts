import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCE, shouldNotify, type Preference } from "@/notifications/preferences";
import { dedupeKeyFor, isNegative, NEGATIVE_RATING_THRESHOLD } from "@/notifications/service";
import { renderReviewAlertEmail } from "@/messaging/templates";

/**
 * The notification decisions, without a database (P1a-T5).
 *
 * Two things are worth pinning here. First, the matrix of preference × review:
 * this is the code that decides whether someone's evening is interrupted, and
 * every wrong cell is either a missed complaint or a reason to mute the
 * product. Second, the alert email — specifically that review text is escaped,
 * since it is the same untrusted input the prompts treat with suspicion.
 */

function preference(overrides: Partial<Preference> = {}): Preference {
  return { ...DEFAULT_PREFERENCE, ...overrides };
}

describe("what counts as negative", () => {
  it("treats a low rating as negative", () => {
    expect(isNegative({ rating: 1, sentiment: null })).toBe(true);
    expect(isNegative({ rating: NEGATIVE_RATING_THRESHOLD, sentiment: null })).toBe(true);
  });

  it("does not treat a good rating as negative on its own", () => {
    expect(isNegative({ rating: 4, sentiment: null })).toBe(false);
    expect(isNegative({ rating: 5, sentiment: "positive" })).toBe(false);
  });

  it("treats negative sentiment as negative whatever the stars say", () => {
    // "Great, if you enjoy waiting an hour." Five stars, and a complaint.
    expect(isNegative({ rating: 5, sentiment: "negative" })).toBe(true);
  });

  it("still flags a low rating the model read as neutral", () => {
    // Requiring both signals would let a 1-star arrive as routine news.
    expect(isNegative({ rating: 1, sentiment: "neutral" })).toBe(true);
  });

  it("handles a review with neither signal", () => {
    expect(isNegative({ rating: null, sentiment: null })).toBe(false);
  });
});

describe("who gets notified", () => {
  it("sends everything to a default user", () => {
    expect(shouldNotify(preference(), { negative: false })).toEqual({
      inApp: true,
      email: true,
      deferEmail: false,
    });
  });

  it("sends nothing when the user turned it off, even for a negative review", () => {
    // "Off" has to mean off. A product that overrides it for urgent items is a
    // product whose settings nobody trusts.
    expect(shouldNotify(preference({ scope: "off" }), { negative: true })).toEqual({
      inApp: false,
      email: false,
      deferEmail: false,
    });
  });

  it("skips a positive review for a negative-only user", () => {
    const decision = shouldNotify(preference({ scope: "negative_only" }), { negative: false });
    expect(decision.inApp).toBe(false);
    expect(decision.email).toBe(false);
  });

  it("sends a negative review to a negative-only user", () => {
    const decision = shouldNotify(preference({ scope: "negative_only" }), { negative: true });
    expect(decision.inApp).toBe(true);
    expect(decision.email).toBe(true);
  });

  it("still creates the feed entry when email is held for the digest", () => {
    const decision = shouldNotify(preference({ delivery: "digest" }), { negative: false });

    // Digest defers the *email*. Dropping the in-app row too would leave a user
    // who wanted a calmer inbox with no record of the review at all.
    expect(decision.inApp).toBe(true);
    expect(decision.email).toBe(false);
    expect(decision.deferEmail).toBe(true);
  });

  it("respects a user who wants in-app only", () => {
    const decision = shouldNotify(preference({ email: false }), { negative: true });
    expect(decision.inApp).toBe(true);
    expect(decision.email).toBe(false);
    expect(decision.deferEmail).toBe(false);
  });

  it("respects a user who wants email only", () => {
    const decision = shouldNotify(preference({ inApp: false }), { negative: false });
    expect(decision.inApp).toBe(false);
    expect(decision.email).toBe(true);
  });
});

describe("deduplication", () => {
  it("is stable for the same review", () => {
    expect(dedupeKeyFor("new_review", "abc")).toBe(dedupeKeyFor("new_review", "abc"));
  });

  it("differs between reviews", () => {
    expect(dedupeKeyFor("new_review", "abc")).not.toBe(dedupeKeyFor("new_review", "def"));
  });
});

describe("the alert email", () => {
  const base = {
    recipientName: "Ayşe",
    businessName: "Kahve Dünyası",
    locationName: "Kadıköy",
    source: "google",
    rating: 2,
    authorName: "Mehmet",
    excerpt: "Servis çok yavaştı.",
    urgent: true,
    link: "https://app.example.com/inbox?review=1",
    settingsUrl: "https://app.example.com/settings#notifications",
  } as const;

  it("writes a Turkish subject for a Turkish recipient", () => {
    const message = renderReviewAlertEmail({ ...base, locale: "tr" });
    expect(message.subject).toContain("Kadıköy");
    expect(message.subject).toMatch(/Dikkat/);
  });

  it("writes an English subject for an English recipient", () => {
    const message = renderReviewAlertEmail({ ...base, locale: "en" });
    expect(message.subject).toMatch(/Heads up/);
  });

  it("marks an urgent review differently from a routine one", () => {
    const urgent = renderReviewAlertEmail({ ...base, locale: "en" });
    const routine = renderReviewAlertEmail({ ...base, locale: "en", urgent: false, rating: 5 });

    expect(urgent.subject).not.toBe(routine.subject);
    expect(routine.subject).toMatch(/New review/);
  });

  it("escapes review text rather than rendering it as markup", () => {
    const message = renderReviewAlertEmail({
      ...base,
      locale: "en",
      excerpt: '<img src=x onerror="alert(1)">',
    });

    // Review text is untrusted input in an email exactly as it is in a prompt.
    expect(message.html).not.toContain("<img");
    expect(message.html).toContain("&lt;img");
  });

  it("escapes an author name too", () => {
    const message = renderReviewAlertEmail({
      ...base,
      locale: "en",
      authorName: '"><script>x</script>',
    });

    expect(message.html).not.toContain("<script>");
  });

  it("says so when a review is a rating with no words", () => {
    const message = renderReviewAlertEmail({ ...base, locale: "en", excerpt: null });
    expect(message.text).toMatch(/rating only/i);
  });

  it("links to settings rather than offering an unsubscribe", () => {
    const message = renderReviewAlertEmail({ ...base, locale: "en" });

    // This is an internal alert to a team member, not a commercial message to a
    // customer: the KVKK reason-for-receipt line and opt-out belong on the
    // review-request email, not here.
    expect(message.text).toContain(base.settingsUrl);
    expect(message.text.toLowerCase()).not.toContain("unsubscribe");
  });

  it("renders stars for a rated review", () => {
    const message = renderReviewAlertEmail({ ...base, locale: "en", rating: 2 });
    expect(message.text).toContain("★★☆☆☆");
  });
});
