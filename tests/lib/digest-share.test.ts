import { describe, expect, it } from "vitest";
import type { DigestView } from "@/digest/queries";
import { digestShareText, type ShareableDigest } from "@/digest/share";
import { toShareableDigest } from "@/digest/shareable";

/**
 * Taking a digest somewhere else (W2.1).
 *
 * The plain-text share is the half that actually gets used in the launch
 * market: an owner copies the week into WhatsApp and sends it to a branch
 * manager. So the assertions are about what survives that trip — no markup, the
 * evidence intact, and nothing that only works inside the app.
 *
 * The PDF is not asserted here beyond its content shape. What a rendered PDF
 * *looks* like is not something a unit test can see, and the two defects that
 * mattered — an absolutely-positioned footer that emits nothing, and a `render`
 * callback that does the same — were both found by rendering the file and
 * looking at it. `src/digest/pdf.ts` records them where somebody would go to
 * add them back.
 */

const DIGEST: ShareableDigest = {
  scopeName: "Kadıköy Kahve — Kadıköy Şubesi",
  period: "27 Temmuz – 2 Ağustos 2026",
  eyebrow: "Bu hafta",
  headline: "Servis hızı bu hafta en çok şikâyet edilen konu.",
  summary: "Puan ortalaması yükseldi ama bekleme süresi hâlâ sorun.",
  pulse: {
    label: "İtibar nabzı",
    value: "86,2",
    meta: "31 yorum",
    delta: "geçen haftaya göre +5,2",
    direction: "up",
  },
  actionsTitle: "Şu üç şeyi yapın",
  actions: [
    {
      position: 1,
      text: "Öğle saatlerinde bir kişi daha görevlendirin.",
      quote: "★★☆☆☆ “Yirmi dakika bekledik.”",
      meta: "bekleme süresi temasında 4 yorum · Yapıldı",
    },
    { position: 2, text: "Bekleyen yorumlara yanıt verin.", quote: null, meta: null },
  ],
  actionsEmpty: "Yapılacak bir şey yok.",
  changesTitle: "Neler değişti",
  changes: [{ key: "a", text: "Yorum sayısı 2 iken 13 oldu.", direction: "up" }],
  themesTitle: "Müşteriler neyi konuştu",
  themes: [{ key: "t", label: "bekleme süresi", meta: "6 yorum" }],
  footer: "Kadıköy Kahve — Kadıköy Şubesi",
};

describe("the shareable text", () => {
  it("leads with who and when, then the week's sentence", () => {
    const text = digestShareText(DIGEST);
    const lines = text.split("\n");

    expect(lines[0]).toBe("Kadıköy Kahve — Kadıköy Şubesi — 27 Temmuz – 2 Ağustos 2026");
    expect(text).toContain("Servis hızı bu hafta en çok şikâyet edilen konu.");
  });

  it("carries the actions with their evidence", () => {
    const text = digestShareText(DIGEST);

    expect(text).toContain("1. Öğle saatlerinde bir kişi daha görevlendirin.");
    expect(text).toContain("★★☆☆☆ “Yirmi dakika bekledik.”");
    expect(text).toContain("2. Bekleyen yorumlara yanıt verin.");
  });

  it("uses no markdown at all", () => {
    // WhatsApp, SMS and a paste into Notes all render `**bold**` literally, and
    // a plan peppered with asterisks reads as broken rather than as emphasised.
    // `★` is a character, not markup, so it is excluded from the check.
    const text = digestShareText(DIGEST);

    expect(text).not.toMatch(/\*\*|__|^#|\]\(/mu);
  });

  it("does not paste a link that would land on a sign-in page", () => {
    // `/weekly-plan/{id}` needs a session. A share that sends somebody outside the
    // team to a login form is worse than one that offers no link.
    expect(digestShareText(DIGEST)).not.toMatch(/https?:\/\//u);
  });

  it("states the pulse with its sample and its change on one line", () => {
    expect(digestShareText(DIGEST)).toContain(
      "İtibar nabzı: 86,2 · 31 yorum · geçen haftaya göre +5,2",
    );
  });

  it("says nothing about a pulse it could not measure", () => {
    // Absence is not zero. A quiet week has no score, and printing one — even
    // as a dash inside the pulse line — reads as a measurement that was taken.
    // The whole line goes, label and all.
    const text = digestShareText({
      ...DIGEST,
      pulse: { ...DIGEST.pulse, value: null, delta: null, direction: null },
    });

    expect(text).not.toContain("İtibar nabzı");
    expect(text).not.toContain("31 yorum");
  });

  it("falls back to a sentence when there is nothing to do", () => {
    const text = digestShareText({ ...DIGEST, actions: [] });

    expect(text).toContain("Şu üç şeyi yapın");
    expect(text).toContain("Yapılacak bir şey yok.");
  });

  it("omits a section it has nothing to put in", () => {
    const text = digestShareText({ ...DIGEST, changes: [], themes: [] });

    expect(text).not.toContain("Neler değişti");
    expect(text).not.toContain("Müşteriler neyi konuştu");
  });
});

/**
 * Turning a stored digest into something exportable.
 *
 * The seam both renderers sit on, so a mistake here is a mistake in the PDF an
 * owner prints *and* the message they paste. The translator is a stub that
 * echoes its key, which makes the assertions about **which** key was chosen
 * rather than about copy that will be reworded.
 */
describe("toShareableDigest", () => {
  const t = ((key: string, values?: Record<string, string | number>) =>
    values ? `${key}(${Object.values(values).join(",")})` : key) as Parameters<
    typeof toShareableDigest
  >[0]["t"];

  const format = { number: (value: number) => value.toFixed(1).replace(".", ",") };

  const view = (overrides: Partial<DigestView> = {}): DigestView =>
    ({
      id: "d1",
      locationId: "loc-1",
      periodStart: new Date("2026-07-27T00:00:00Z"),
      periodEnd: new Date("2026-08-03T00:00:00Z"),
      status: "ready",
      pulseScore: 86.24,
      pulseDelta: 5.2,
      reviewCount: 31,
      locale: "tr",
      generatedAt: new Date("2026-08-03T02:00:00Z"),
      payload: {
        headline: "Servis hızı en çok konuşulan konu.",
        summary: "Özet.",
        callouts: [],
        changes: [],
        themes: [
          {
            label: "servis",
            slugs: ["servis"],
            count: 4,
            positive: 1,
            negative: 3,
            averageSentiment: -0.4,
            quotes: [{ reviewId: "r1", text: "Yirmi dakika bekledik.", rating: 2 }],
          },
        ],
        assets: { replyDrafts: [], socialPost: null },
        priorActionsOutcome: null,
      },
      actions: [
        {
          id: "a1",
          position: 1,
          text: "Bir kişi daha görevlendirin.",
          status: "open",
          evidence: { themeSlug: "servis", reviewIds: ["r1"] },
        },
      ],
      ...overrides,
    }) as DigestView;

  const build = (overrides: Partial<DigestView> = {}) =>
    toShareableDigest({
      digest: view(overrides),
      scopeName: "Kadıköy",
      period: "27 Tem",
      t,
      // The identity labeller: this suite is about the *seam*, and a fixture
      // using free tags exercises the pass-through half of `themeLabel`.
      // `tests/lib/digest-themes.test.ts` covers the canonical half.
      themeLabel: (key) => key,
      format,
    });

  it("resolves each action's citation to the quote the model was shown", () => {
    // The same payload the screen reads, so an exported quote cannot be a fresh
    // read of text that has since been edited or deleted.
    expect(build().actions[0]?.quote).toBe("★★☆☆☆ “Yirmi dakika bekledik.”");
  });

  it("carries an action's status, so a printed plan does not get done twice", () => {
    const done = build({
      actions: [
        {
          id: "a1",
          position: 1,
          text: "Bir kişi daha görevlendirin.",
          status: "done",
          evidence: { themeSlug: "servis", reviewIds: ["r1"] },
        },
      ] as DigestView["actions"],
    });

    expect(done.actions[0]?.meta).toContain("doneLabel");
  });

  it("says a quiet week happened rather than printing a blank cover", () => {
    // A thin or refused week has no composed headline (W1.6). An empty string
    // would produce a PDF whose first line is missing.
    expect(build({ payload: null }).headline).toBe("quietWeek");
  });

  it("leaves the pulse null when there was nothing to measure", () => {
    expect(build({ pulseScore: null, pulseDelta: null }).pulse.value).toBeNull();
    expect(build({ pulseScore: null, pulseDelta: null }).pulse.delta).toBeNull();
  });

  it("reads a pulse that has not moved as level rather than as +0", () => {
    expect(build({ pulseDelta: 0 }).pulse).toMatchObject({ delta: "deltaFlat", direction: "flat" });
  });

  it("leaves an action with no citation without a quote rather than borrowing one", () => {
    const orphan = build({
      actions: [
        {
          id: "a1",
          position: 1,
          text: "Bir şey yapın.",
          status: "open",
          evidence: { themeSlug: "servis", reviewIds: [] },
        },
      ] as DigestView["actions"],
    });

    expect(orphan.actions[0]?.quote).toBeNull();
  });
});
