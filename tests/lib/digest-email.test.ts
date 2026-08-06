import { describe, expect, it } from "vitest";
import { renderDigestEmail, type DigestEmailInput } from "@/messaging/templates";

/**
 * The digest email template (D1 — docs/14-digest-surfaces.md).
 *
 * Pure rendering, so it is tested without a database or a transport. The three
 * things worth pinning down are the ones a reader would notice and a reviewer
 * would not: that the *whole* briefing is in the body rather than a link to it,
 * that the window reads as a week rather than eight days, and that model output
 * derived from review text is escaped before it reaches an HTML email.
 */

const BASE: DigestEmailInput = {
  locale: "en",
  recipientName: "Ayşe",
  businessName: "Kahve Dünyası",
  locationName: "Kadıköy",
  periodStart: new Date("2026-07-27T00:00:00Z"),
  periodEnd: new Date("2026-08-03T00:00:00Z"),
  pulseScore: 72,
  pulseDelta: 4.2,
  reviewCount: 18,
  headline: "Service picked up, coffee held steady",
  summary: "Eighteen reviews this week, and the wait-time complaints have stopped.",
  actions: [
    {
      position: 1,
      text: "Thank the four regulars who mentioned Deniz by name.",
      quote: { text: "Deniz remembered my order. Made my morning.", rating: 5 },
      reviewCount: 4,
      link: "https://app.test/inbox?location=loc-1&reviews=r1,r2",
    },
    {
      position: 2,
      text: "Reply to the two unanswered one-star reviews.",
      quote: { text: "Nobody ever answered my complaint.", rating: 1 },
      reviewCount: 2,
      link: "https://app.test/inbox?location=loc-1&reviews=r3,r4",
    },
    // No citation — a digest composed before W1.6 stored none.
    {
      position: 3,
      text: "Restock the oat milk before the weekend.",
      quote: null,
      reviewCount: 0,
      link: null,
    },
  ],
  themes: [
    { label: "Service", count: 9, positive: 7, negative: 2 },
    { label: "Coffee", count: 6, positive: 6, negative: 0 },
  ],
  priorOutcome: null,
  heldCount: 0,
  link: "https://app.test/digest/abc-123",
  settingsUrl: "https://app.test/settings#notifications",
};

describe("the digest email carries the briefing itself", () => {
  it("puts the headline, summary and all three actions in the body", () => {
    const mail = renderDigestEmail(BASE);

    expect(mail.text).toContain("Service picked up, coffee held steady");
    expect(mail.text).toContain("the wait-time complaints have stopped");

    for (const action of BASE.actions) {
      expect(mail.text).toContain(action.text);
      expect(mail.html).toContain(action.text);
    }
  });

  it("links to the archive entry rather than making the link the message", () => {
    const mail = renderDigestEmail(BASE);

    expect(mail.text).toContain("https://app.test/digest/abc-123");
    // The point of the assertion above is only meaningful alongside this one:
    // the link is present *and* the email stands on its own without it.
    expect(mail.text).toContain("Three things to do this week");
  });

  it("states the pulse with its change against last week", () => {
    const mail = renderDigestEmail(BASE);

    expect(mail.text).toContain("72/100");
    expect(mail.text).toContain("+4.2 on last week");
  });

  it("says so plainly when there is no prior week to compare against", () => {
    const mail = renderDigestEmail({ ...BASE, pulseDelta: null });

    expect(mail.text).toContain("72/100");
    expect(mail.text).not.toContain("on last week");
  });

  it("reports a pulse that has not moved as level rather than as +0", () => {
    const mail = renderDigestEmail({ ...BASE, pulseDelta: 0 });

    expect(mail.text).toContain("level with last week");
    expect(mail.text).not.toContain("+0");
  });
});

describe("the window reads the way a person would say it", () => {
  it("prints the inclusive end, so a seven-day week is not eight days", () => {
    // `periodEnd` is exclusive in the database — 3 August 00:00 means the week
    // ends *after* 2 August. Printing the stored value would say "27 Jul – 3
    // Aug", which a reader counts as eight days.
    const mail = renderDigestEmail(BASE);

    expect(mail.subject).toContain("Jul 27 – Aug 2");
    expect(mail.subject).not.toContain("Aug 3");
  });

  it("orders the date parts by locale rather than by our own habit", () => {
    // Turkish puts the day first. Hard-coding one order would be wrong in one
    // of the two launch languages.
    expect(renderDigestEmail({ ...BASE, locale: "tr" }).subject).toContain("27 Tem – 2 Ağu");
  });
});

describe("a quiet week", () => {
  const quiet: DigestEmailInput = {
    ...BASE,
    reviewCount: 0,
    pulseScore: null,
    pulseDelta: null,
    headline: "",
    summary: "",
    actions: [],
    themes: [],
  };

  it("still sends, and says there was nothing rather than nothing at all", () => {
    const mail = renderDigestEmail(quiet);

    // Silence has to be distinguishable from a broken pipeline, and the only
    // place that distinction can be made is the recipient's inbox.
    expect(mail.text).toContain("No new reviews came in this week");
    expect(mail.text).toContain("not enough data yet");
  });

  it("omits the sections it has nothing to put in", () => {
    const mail = renderDigestEmail(quiet);

    expect(mail.text).not.toContain("Three things to do this week");
    expect(mail.text).not.toContain("What customers talked about");
  });
});

describe("held new-review alerts", () => {
  it("is silent when nothing was held", () => {
    expect(renderDigestEmail(BASE).text).not.toContain("asked us to hold");
  });

  it("accounts for the alerts the recipient chose to defer", () => {
    const mail = renderDigestEmail({ ...BASE, heldCount: 5 });

    expect(mail.text).toContain("5 new-review alerts you asked us to hold");
  });

  it("does not say '1 alerts'", () => {
    expect(renderDigestEmail({ ...BASE, heldCount: 1 }).text).toContain("1 new-review alert you");
  });
});

/**
 * Every action carries its evidence (W2.1).
 *
 * The email was three bare sentences while the screen showed the customer's own
 * words and a link to the exact reviews — so the surface most owners actually
 * read was the one asking to be taken on trust. These assertions are about the
 * *plain-text* part as much as the HTML: text is what a client that refuses
 * HTML shows, and evidence that exists only in the rich version is evidence the
 * most cautious reader never sees.
 */
describe("the evidence behind each action", () => {
  it("quotes a customer, with their rating, beside the recommendation", () => {
    const mail = renderDigestEmail(BASE);

    expect(mail.html).toContain("Deniz remembered my order.");
    expect(mail.text).toContain('"Deniz remembered my order. Made my morning."');
    // ★★★★★ for a five. The one part of the on-screen card an email can copy.
    expect(mail.html).toContain("★★★★★");
    expect(mail.html).toContain("★☆☆☆☆");
  });

  it("links each action to its own reviews, not to one digest-wide page", () => {
    const mail = renderDigestEmail(BASE);

    expect(mail.html).toContain("reviews=r1,r2");
    expect(mail.html).toContain("reviews=r3,r4");
    expect(mail.text).toContain("See the 4 reviews behind this");
    expect(mail.text).toContain("See the 2 reviews behind this");
  });

  it("renders an action with no citation rather than dropping it", () => {
    // A digest composed before W1.6 stored none. The sentence is still worth
    // sending; what it must not do is show a link that goes nowhere.
    const mail = renderDigestEmail(BASE);

    expect(mail.html).toContain("Restock the oat milk");
    expect(mail.text).toContain("3. Restock the oat milk before the weekend.");
    expect(mail.html).not.toContain("reviews=&");
  });

  it("does not say 'the 1 reviews'", () => {
    const mail = renderDigestEmail({
      ...BASE,
      actions: [
        {
          position: 1,
          text: "Answer the one-star.",
          quote: null,
          reviewCount: 1,
          link: "https://app.test/inbox?reviews=r9",
        },
      ],
    });

    expect(mail.text).toContain("See the review behind this");
  });

  it("shows no stars for a review that has none", () => {
    // A DM or a comment carries no rating, and five hollow stars would read as
    // zero rather than as absent.
    const mail = renderDigestEmail({
      ...BASE,
      actions: [
        {
          position: 1,
          text: "Answer the direct message.",
          quote: { text: "Are you open on Sunday?", rating: null },
          reviewCount: 1,
          link: null,
        },
      ],
    });

    expect(mail.html).toContain("Are you open on Sunday?");
    expect(mail.html).not.toContain("☆");
  });
});

describe("last week's follow-through", () => {
  it("is silent before there is a last week", () => {
    expect(renderDigestEmail(BASE).text).not.toContain("You completed");
  });

  it("reports what was closed, from the frozen payload", () => {
    // Frozen on purpose: an email cannot update, so the number it states must
    // be the one that was true when it was sent. The screen's card reads live.
    const mail = renderDigestEmail({ ...BASE, priorOutcome: { done: 2, total: 3 } });

    expect(mail.text).toContain("You completed 2 of last week's 3 actions.");
    expect(mail.html).toContain("You completed 2 of last week&#39;s 3 actions.");
  });
});

describe("untrusted text", () => {
  it("escapes model output before it reaches the HTML body", () => {
    // The headline, summary, actions and theme labels are all model output
    // derived from review text — untrusted input in an email exactly as it is
    // in a prompt.
    const mail = renderDigestEmail({
      ...BASE,
      headline: '<script>alert("xss")</script>',
      summary: "Ali & Ayşe said <b>great</b>",
      actions: [
        {
          position: 1,
          text: "Fix <img src=x onerror=alert(1)>",
          // A customer's own words reach a mail client verbatim, so the quote
          // is untrusted input exactly as the model's sentence is.
          quote: { text: '<svg onload=alert("quote")>', rating: 3 },
          reviewCount: 1,
          link: "https://app.test/inbox?location=loc-1&reviews=r1",
        },
      ],
      themes: [{ label: "<i>Service</i>", count: 3, positive: 2, negative: 1 }],
    });

    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).not.toContain("<b>great</b>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).not.toContain("<svg onload");
    expect(mail.html).toContain("Ali &amp; Ayşe");
  });

  it("leaves the plain-text part as written", () => {
    // Text has no markup to escape into, and escaping it there would show a
    // reader `&amp;` in their inbox.
    const mail = renderDigestEmail({ ...BASE, summary: "Ali & Ayşe" });

    expect(mail.text).toContain("Ali & Ayşe");
  });
});

describe("both languages", () => {
  it("renders Turkish throughout, including the subject", () => {
    const mail = renderDigestEmail({ ...BASE, locale: "tr" });

    expect(mail.subject).toContain("haftalık özet");
    expect(mail.text).toContain("Bu hafta yapılacak üç şey");
    expect(mail.text).toContain("İtibar nabzı: 72/100");
    expect(mail.html).toContain('lang="tr"');
  });

  it("carries the reason-for-receipt and a route to change it, in both", () => {
    for (const locale of ["en", "tr"] as const) {
      const mail = renderDigestEmail({ ...BASE, locale });

      // This goes to a team member about their own business, so the footer
      // points at notification settings — it is not marketing and does not
      // carry a KVKK unsubscribe. See the review-request template for the
      // email that does.
      expect(mail.text).toContain("https://app.test/settings#notifications");
      expect(mail.html).toContain("settings#notifications");
    }
  });
});
