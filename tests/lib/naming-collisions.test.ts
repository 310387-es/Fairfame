import { describe, expect, it } from "vitest";
import en from "@/i18n/messages/en.json";
import tr from "@/i18n/messages/tr.json";

/**
 * One word, one thing.
 *
 * The product called two different objects a "campaign", one rail-click apart:
 *
 *   - a **collection campaign** — the `campaigns` table, `src/collect/
 *     campaigns.ts`, `/api/campaigns/{id}/qr`, and the cards on `/get-reviews`
 *     that carry a branch's QR code and public link;
 *   - a **broadcast** — one send to one audience, which W3.1 renamed from
 *     `/broadcasts` to `/campaigns` because campaign is the word a marketer
 *     scans for, without weighing that the word was taken.
 *
 * `CLAUDE.md` recorded it as an open naming decision rather than a bug, and it
 * is the kind that never announces itself: both screens read fine alone. It
 * only bites when somebody is told "check the campaign" and opens the wrong
 * one — and the clearest evidence it was already biting is that the broadcast
 * form had to label its own field **"Collection campaign"** to say which sort
 * it meant.
 *
 * Resolved 8 Aug 2026 by moving the screen that borrowed the word: the table,
 * the folder, the job (`broadcast_sweep`) and the Turkish copy ("Gönderimler",
 * never "kampanya") all said broadcast already.
 *
 * This test is what stops it drifting back. A translator or a later feature
 * reaching for "campaign" inside the broadcast namespace is the exact move that
 * recreates the collision, and it would otherwise be invisible in review.
 */

/** Namespaces that legitimately talk about the `campaigns` table. */
const MAY_SAY_CAMPAIGN = [
  // `/get-reviews` — the collection campaigns themselves.
  "requests",
  // The contact profile's "Ask for a review", which picks one.
  "contacts.sendCampaign",
  "contacts.sendNoCampaign",
  // The broadcast form's picker: *which collection campaign to send under*.
  // One key, deliberately — see the assertion below.
  "broadcasts.campaign",
  "broadcasts.noCampaigns",
  // İYS consent wording, where "campaigns and offers" is ordinary marketing
  // English about commercial messages in general, not about our entity.
  "collect.iysLabel",
  // The compliance page's no-review-gating statement, explaining that a survey
  // points at a *collection* campaign rather than deciding its own destination.
  // It is the entity, named correctly, and naming it is the whole argument.
  "compliance.gatingPoint2",
  // The landing page's "more real reviews" pillar, which lists the four ways a
  // collection campaign goes out: "WhatsApp, email, SMS and QR campaigns". That
  // is the `/get-reviews` entity named correctly and in the plural — the same
  // object `requests` above owns. It replaced `marketing.shotCollectAlt`, which
  // described a screenshot the rebuilt front door no longer carries.
  "marketing.features.collectBody",
];

function flatten(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (node === null || typeof node !== "object") return [];

  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    flatten(value, path === "" ? key : `${path}.${key}`),
  );
}

describe("the word campaign", () => {
  it("means the collection campaign, and nothing else", () => {
    const stray = flatten(en)
      .filter(([, value]) => /campaign/i.test(value))
      .filter(([key]) => !MAY_SAY_CAMPAIGN.some((allowed) => key.startsWith(allowed)))
      .map(([key, value]) => `${key}: "${value}"`);

    expect(
      stray,
      `These English messages say "campaign" outside the namespaces that own ` +
        `the campaigns table. The product has exactly one campaign — the ` +
        `collection campaign on /get-reviews, with its QR code and public link. ` +
        `A send to an audience is a broadcast. If this is genuinely about a ` +
        `collection campaign, add the key to MAY_SAY_CAMPAIGN with that ` +
        `reason:\n  ${stray.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no longer needs qualifying on the broadcast form", () => {
    // It read "Collection campaign" — a qualifier that only existed because the
    // screen around it was also called Campaigns. On a screen called
    // Broadcasts, the plain noun is unambiguous, and having to disambiguate is
    // the symptom this rename removes rather than merely tidies.
    expect(en.broadcasts.campaign).toBe("Campaign");
    expect(tr.broadcasts.campaign).toBe("Kampanya");
  });

  it("is not what a broadcast is called, in either language", () => {
    const labels = [
      en.broadcasts.title,
      en.tabs.broadcasts,
      en.broadcasts.newBroadcast,
      tr.broadcasts.title,
      tr.tabs.broadcasts,
      tr.broadcasts.newBroadcast,
    ];

    for (const label of labels) {
      expect(label.toLowerCase()).not.toMatch(/campaign|kampanya/);
    }
  });
});
