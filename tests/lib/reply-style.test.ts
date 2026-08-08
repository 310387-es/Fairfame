import { describe, expect, it } from "vitest";
import {
  appendSignature,
  DEFAULT_REPLY_STYLE,
  MAX_SIGNATURE_CHARS,
  REPLY_LENGTHS,
  REPLY_LENGTH_TARGETS,
  REPLY_TONES,
  styleInstructions,
} from "../../src/replies/style.ts";
import { draftReplyPrompt, MAX_REPLY_CHARS } from "../../src/prompts/index.ts";

/**
 * Reply tone, length and signature (W4 fold-in, W5-12).
 *
 * Two things are worth pinning here and neither is "does the string say the
 * right words".
 *
 * The first is that **the default style changes nothing**. The digest pipeline
 * and Home's one-click queue both draft without asking anybody for a stance,
 * and if `default` quietly meant "warm" then a scheduled draft would acquire an
 * opinion nobody chose.
 *
 * The second is that **appending a signature is idempotent**. Regeneration
 * lands on text that frequently already carries one, and a doubled sign-off is
 * the kind of defect that is invisible in review and obvious to the customer
 * reading it.
 */

describe("styleInstructions", () => {
  it("says nothing about tone under the default stance", () => {
    const lines = styleInstructions(DEFAULT_REPLY_STYLE);
    // Exactly one line, and it is the length. The absence of a stance is a
    // choice, not a fifth tone that means "warm".
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(String(REPLY_LENGTH_TARGETS.standard));
  });

  it("adds a stance line for every non-default tone", () => {
    for (const tone of REPLY_TONES) {
      const lines = styleInstructions({ tone, length: "standard" });
      expect(lines).toHaveLength(tone === "default" ? 1 : 2);
    }
  });

  it("carries a distinct target for every length", () => {
    const targets = REPLY_LENGTHS.map((length) => REPLY_LENGTH_TARGETS[length]);
    expect(new Set(targets).size).toBe(REPLY_LENGTHS.length);
    // A target above the hard limit would ask the model for something
    // `boundOutput` then truncates mid-sentence.
    for (const target of targets) expect(target).toBeLessThanOrEqual(MAX_REPLY_CHARS);
  });

  it("orders the lengths shortest first, which is how they are rendered", () => {
    const targets = REPLY_LENGTHS.map((length) => REPLY_LENGTH_TARGETS[length]);
    expect([...targets].sort((a, b) => a - b)).toEqual(targets);
  });
});

describe("draftReplyPrompt", () => {
  const base = { text: "Servis çok yavaştı.", rating: 2, businessName: "Kahve Dünyası" };

  it("is version 2 and carries the chosen stance", () => {
    const prompt = draftReplyPrompt({
      ...base,
      brandTone: "warm",
      style: { tone: "apologetic", length: "short" },
    });

    expect(prompt.id).toBe("draft_reply@2");
    const instruction = JSON.stringify(prompt.request);
    expect(instruction).toContain("apolog");
    expect(instruction).toContain(String(REPLY_LENGTH_TARGETS.short));
  });

  it("keeps the brand voice when a stance is chosen — they compose, not compete", () => {
    const prompt = draftReplyPrompt({
      ...base,
      brandTone: "never corporate",
      style: { tone: "formal", length: "long" },
    });

    expect(JSON.stringify(prompt.request)).toContain("never corporate");
  });

  it("without a style, says only what an unstyled draft always said", () => {
    const styled = draftReplyPrompt({ ...base, brandTone: "warm" });
    const explicit = draftReplyPrompt({ ...base, brandTone: "warm", style: DEFAULT_REPLY_STYLE });
    expect(JSON.stringify(styled.request)).toBe(JSON.stringify(explicit.request));
  });
});

describe("appendSignature", () => {
  it("appends after a blank line", () => {
    expect(appendSignature("Teşekkürler.", "— Ayşe")).toBe("Teşekkürler.\n\n— Ayşe");
  });

  it("does not sign twice — the regeneration case", () => {
    const once = appendSignature("Teşekkürler.", "— Ayşe");
    expect(appendSignature(once, "— Ayşe")).toBe(once);
  });

  it("recognises a signature the writer typed themselves", () => {
    expect(appendSignature("Teşekkürler.\n— Ayşe", "— Ayşe")).toBe("Teşekkürler.\n— Ayşe");
  });

  it("tolerates trailing whitespace on either side", () => {
    expect(appendSignature("Teşekkürler.\n\n— Ayşe  \n", "  — Ayşe ")).toBe(
      "Teşekkürler.\n\n— Ayşe",
    );
  });

  it("leaves the text alone when the branch has no signature", () => {
    expect(appendSignature("Teşekkürler.", null)).toBe("Teşekkürler.");
    expect(appendSignature("Teşekkürler.", "   ")).toBe("Teşekkürler.");
  });

  it("does not open with a blank line when there is nothing to sign yet", () => {
    expect(appendSignature("", "— Ayşe")).toBe("— Ayşe");
  });

  it("keeps signatures short enough to stay a name and a place", () => {
    // Not a behavioural assertion — a reminder in test form. The moment this
    // ceiling grows, somebody's opening hours end up on the end of an apology.
    expect(MAX_SIGNATURE_CHARS).toBeLessThanOrEqual(200);
  });
});
