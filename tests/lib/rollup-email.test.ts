import { describe, expect, it } from "vitest";
import { LOCALES, type Locale } from "@/i18n/config";
import { renderReviewAlertEmail, renderRollupEmail } from "@/messaging/templates";

/**
 * The email for a pile, and the one for a handoff.
 *
 * Both exist because of the same shipped bug. `sendPendingEmails` rendered every
 * pending notification through the *review alert* template, and a rollup payload
 * carries a count and a location name and nothing else — so an SLA rollup with
 * email enabled went out with no stars, no quote, no author, and a call to
 * action pointing at `/inbox?review=undefined`. Nothing failed; a customer's
 * team simply received a broken email from their reputation tool.
 *
 * These assert the two properties that would have caught it: a rollup email
 * says the number it is about and links to a queue, and it never claims to be
 * about one review.
 */

const rollup = (overrides: Partial<Parameters<typeof renderRollupEmail>[0]> = {}) =>
  renderRollupEmail({
    locale: "en",
    recipientName: "Ayşe",
    businessName: "Kadıköy Kahve",
    locationName: "Kadıköy",
    count: 23,
    kind: "sla",
    link: "https://app.example.com/inbox?overdue=1",
    settingsUrl: "https://app.example.com/settings#notifications",
    ...overrides,
  });

describe("the rollup email", () => {
  it("leads with the number it is about", () => {
    const email = rollup();

    expect(email.subject).toContain("23");
    expect(email.text).toContain("23");
    expect(email.html).toContain("23");
  });

  it("links to the queue, never to a review", () => {
    const email = rollup();

    expect(email.text).toContain("/inbox?overdue=1");
    // The exact failure that shipped: a review link built from a payload that
    // has no review in it.
    expect(email.html).not.toContain("review=undefined");
    expect(email.html).not.toContain("review=");
  });

  it("says which pile it is about", () => {
    // A lapsed deadline and a handoff are different news and must not share a
    // subject line — an assignment is not an alarm.
    const overdue = rollup({ kind: "sla" });
    const assigned = rollup({
      kind: "assignment",
      link: "https://app.example.com/inbox?assignee=me",
    });

    expect(overdue.subject).not.toBe(assigned.subject);
    expect(assigned.subject.toLowerCase()).toContain("assigned");
  });

  it("carries no stars, author or quote, because it has none", () => {
    const email = rollup();

    expect(email.text).not.toContain("★");
    expect(email.text).not.toContain("undefined");
    expect(email.html).not.toContain("undefined");
  });

  it("still says why it arrived and how to stop it", () => {
    // A team member's alert points at settings, not an unsubscribe — but it
    // must point somewhere.
    const email = rollup();
    expect(email.text).toContain("/settings#notifications");
  });

  it("renders in both languages", () => {
    for (const locale of LOCALES) {
      const email = rollup({ locale: locale as Locale });

      expect(email.subject.length).toBeGreaterThan(0);
      expect(email.html).toContain(`<html lang="${locale}"`);
      // A missing copy entry would interpolate the word "undefined" rather than
      // throwing, which is exactly the class of failure this file exists for.
      expect(email.subject).not.toContain("undefined");
    }
  });

  it("escapes a location name somebody typed", () => {
    const email = rollup({ locationName: "<script>alert(1)</script>" });

    expect(email.html).not.toContain("<script>alert");
    expect(email.html).toContain("&lt;script&gt;");
  });
});

describe("an assigned review's own alert", () => {
  const alert = (reason: "arrived" | "assigned") =>
    renderReviewAlertEmail({
      locale: "en",
      recipientName: "Ayşe",
      businessName: "Kadıköy Kahve",
      locationName: "Kadıköy",
      source: "google",
      rating: 5,
      authorName: "Mehmet",
      excerpt: "Lovely coffee.",
      urgent: false,
      reason,
      link: "https://app.example.com/inbox?review=abc",
      settingsUrl: "https://app.example.com/settings#notifications",
    });

  it("does not claim the review just arrived", () => {
    // It may have arrived last Tuesday. What happened this morning is that
    // somebody handed it over, and saying otherwise is simply false.
    const assigned = alert("assigned");

    expect(assigned.text).not.toContain("just came in");
    expect(assigned.text.toLowerCase()).toContain("assigned");
    expect(assigned.subject.toLowerCase()).toContain("assigned");
  });

  it("keeps the review itself, because that is what makes it recognisable", () => {
    const assigned = alert("assigned");

    expect(assigned.text).toContain("Lovely coffee.");
    expect(assigned.text).toContain("Mehmet");
    expect(assigned.text).toContain("★");
  });

  it("still reads as an arrival when that is what it is", () => {
    expect(alert("arrived").text).toContain("just came in");
  });
});
