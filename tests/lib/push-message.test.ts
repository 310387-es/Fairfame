import { describe, expect, it } from "vitest";
import { pushMessageFor } from "../../src/notifications/push.ts";

/**
 * What a push notification says on a lock screen (W5-9).
 *
 * The rule worth pinning is **what it does not say**. A lock screen is readable
 * by whoever is standing next to the phone, so the body is the excerpt the feed
 * already stores rather than the review's full text — a one-star review naming
 * a member of staff is not something to print on a counter in a busy café.
 *
 * The `tag` matters for a different reason: it is what makes a redelivery
 * *replace* a notification rather than stack a second copy of it. Keyed on the
 * review, not on the notification row, because two alerts about one review are
 * one thing to look at.
 */

const base = { id: "n1", organizationName: "Moda Kahve" };

describe("pushMessageFor", () => {
  it("leads with the reviewer and their stars", () => {
    const message = pushMessageFor({
      ...base,
      type: "new_review",
      payload: { reviewId: "r1", authorName: "Ayşe", rating: 2, excerpt: "Servis çok yavaştı." },
    });

    expect(message?.title).toBe("Ayşe ★★");
    expect(message?.body).toBe("Servis çok yavaştı.");
    expect(message?.url).toContain("/reviews?review=r1");
  });

  it("carries the excerpt, never a full review", () => {
    // The payload only ever holds an excerpt — `excerpt()` in the service
    // truncates it — so this asserts the message reads that field and does not
    // reach for anything longer.
    const message = pushMessageFor({
      ...base,
      type: "new_review",
      payload: { reviewId: "r1", excerpt: "Kısa.", text: "A very long review".repeat(50) },
    });

    expect(message?.body).toBe("Kısa.");
  });

  it("falls back to the business name for an anonymous reviewer", () => {
    const message = pushMessageFor({
      ...base,
      type: "new_review",
      payload: { reviewId: "r1", rating: 5 },
    });

    expect(message?.title).toBe("Moda Kahve ★★★★★");
  });

  it("tags by the review, so a redelivery replaces rather than stacks", () => {
    const first = pushMessageFor({ ...base, type: "new_review", payload: { reviewId: "r1" } });
    const again = pushMessageFor({
      ...base,
      id: "n2",
      type: "sla_breach",
      payload: { reviewId: "r1" },
    });

    expect(first?.tag).toBe(again?.tag);
  });

  it("sends a rollup to the queue rather than to one review", () => {
    const message = pushMessageFor({
      ...base,
      type: "sla_rollup",
      payload: { count: 23, locationName: "Kadıköy" },
    });

    expect(message?.body).toBe("23 · Kadıköy");
    expect(message?.url).toContain("/reviews?reply=unanswered");
  });

  it("says nothing at all rather than something empty", () => {
    // A notification we cannot describe is not worth waking somebody for; the
    // in-app feed still has the row.
    expect(pushMessageFor({ ...base, type: "new_review", payload: {} })).toBeNull();
    expect(pushMessageFor({ ...base, type: "sla_rollup", payload: {} })).toBeNull();
  });
});
