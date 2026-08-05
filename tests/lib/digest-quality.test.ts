import { describe, expect, it } from "vitest";
import { hasTurkishLetters, looksAsciiFolded } from "@/ai/guardrails";
import { DIGEST_LEVERS, digestPrompt, digestSchema } from "@/prompts/index";

/**
 * The digest refuses to be filler (W1.6).
 *
 * **What the audit found on the product's hero screen:** three confident
 * Turkish sentences written without a single Turkish letter, and under every
 * action the words "0 reviews". Not a crash, not a parse error — a briefing
 * that looked finished and said nothing, which is the worst failure this
 * feature has, because an owner who acts on it once and finds nothing there
 * stops opening it.
 *
 * Four of the five fixes are structural and testable without a model: the
 * response schema demands evidence and a lever, the prompt names the closed
 * list, and the diacritic check compares output against the material it was
 * written from. The fifth — which model composes it — is configuration, and is
 * asserted in `.env.example` rather than here.
 */

describe("an action must carry evidence", () => {
  const actionSchema = digestSchema.properties.actions.items;

  it("requires the quotes it rests on", () => {
    // The thing that makes "0 reviews on …" impossible. Without this the model
    // was asked for a theme name and nothing else, and the pipeline guessed at
    // the reviews behind it — badly, when there were no themes at all.
    expect(actionSchema.required).toContain("quoteRefs");
    expect(actionSchema.properties.quoteRefs.minItems).toBe(1);
  });

  it("requires a lever from the closed list", () => {
    expect(actionSchema.required).toContain("lever");
    expect(actionSchema.properties.lever.enum).toEqual([...DIGEST_LEVERS]);
  });

  it("keeps the list short enough to force a choice", () => {
    // A longer list is a vaguer list: given a "general" bucket the model picks
    // it every time, which is the filler this is meant to prevent.
    expect(DIGEST_LEVERS.length).toBeLessThanOrEqual(6);
    expect(new Set(DIGEST_LEVERS).size).toBe(DIGEST_LEVERS.length);
  });
});

describe("the prompt numbers its quotes", () => {
  const built = digestPrompt({
    locale: "tr",
    businessName: "Kadıköy Kahve",
    locationName: "Moda",
    periodLabel: "2026-07-27 to 2026-08-03",
    pulse: 71,
    priorPulse: 68,
    reviewCount: 9,
    priorReviewCount: 7,
    themes: [{ label: "servis", count: 4, positive: 1, negative: 3 }],
    changes: [],
    quotes: [
      { theme: "servis", text: "Servis çok yavaştı." },
      { theme: "servis", text: "Garson ilgilenmedi." },
    ],
  });

  /** Everything the model is actually sent — instructions and data alike. */
  const sent = [built.request.system ?? "", ...built.request.messages.map((m) => m.text)].join(
    "\n",
  );

  it("prints them one-based, so a citation of 1 means the first", () => {
    // The pipeline maps `quoteRefs` back through this numbering. Off by one
    // here would put somebody else's review behind an action, silently.
    expect(sent).toMatch(/\[1\] \(servis\)/);
    expect(sent).toMatch(/\[2\] \(servis\)/);
  });

  it("tells the model an unsupported action is not an action", () => {
    expect(sent).toMatch(/at least one quote/i);
  });

  it("names every lever it will accept", () => {
    for (const lever of DIGEST_LEVERS) expect(sent).toContain(lever);
  });
});

describe("Turkish that is not Turkish", () => {
  it("rejects a folded briefing written from Turkish material", () => {
    // The exact failure: recognisable Turkish words, every diacritic stripped.
    // It parses, it fits the schema, it clears every length bound, and it reads
    // to a Turkish owner as "these people do not speak my language".
    expect(
      looksAsciiFolded({
        locale: "tr",
        output: "Musteri sikayetleri arttı".replace("ı", "i"),
        source: "Servis çok yavaştı ve garson hiç ilgilenmedi.",
      }),
    ).toBe(true);
  });

  it("accepts a briefing that kept its diacritics", () => {
    expect(
      looksAsciiFolded({
        locale: "tr",
        output: "Müşteri şikâyetleri arttı; servis hızını gözden geçirin.",
        source: "Servis çok yavaştı.",
      }),
    ).toBe(false);
  });

  it("says nothing about English", () => {
    expect(
      looksAsciiFolded({
        locale: "en",
        output: "Service complaints are up this week.",
        source: "The service was very slow.",
      }),
    ).toBe(false);
  });

  it("does not accuse a briefing whose source had no diacritics either", () => {
    // A short Turkish sentence can honestly contain none of these letters, so
    // "no diacritics in the output" is not by itself evidence of anything. What
    // is evidence is output with none while the *source* is full of them.
    expect(
      looksAsciiFolded({
        locale: "tr",
        output: "Bu hafta not alan bir sey yok.",
        source: "Bar temiz, sonuc olarak iyi.",
      }),
    ).toBe(false);
  });

  it("knows the letters that make Turkish Turkish", () => {
    expect(hasTurkishLetters("Kadıköy")).toBe(true);
    expect(hasTurkishLetters("İzmir")).toBe(true);
    expect(hasTurkishLetters("Ankara")).toBe(false);
  });
});
