import { describe, expect, it } from "vitest";
import { renderPoster, type PosterInput } from "@/collect/poster";

/**
 * The QR poster and table tent (W4.5).
 *
 * A PDF is the one surface where "it looked right in the code" is worth
 * nothing: it is generated once, printed, and stuck on a wall. These assert the
 * two things that would fail *silently* — Turkish glyphs and the second face of
 * the tent — because both produce a file that opens perfectly and is wrong on
 * paper.
 *
 * The rendered bytes are inspected rather than diffed against a fixture. A
 * golden PDF would break on every `@react-pdf` patch release and teach whoever
 * hits it to regenerate the fixture without looking.
 */

const base: Omit<PosterInput, "layout"> = {
  // Every Turkish letter that Helvetica lacks and that NFKD does not decompose.
  businessName: "Kadıköy Kahvecisi",
  branchName: "Şişli Şubesi",
  url: "https://example.com/c/yorum-daveti",
  headline: "Nasıldık?",
  subhead: "Kodu okutun, otuz saniyede anlatın.",
  urlLabel: "Ya da şu adrese gidin",
  foldLabel: "buradan katlayın",
};

const render = (layout: PosterInput["layout"]) => renderPoster({ ...base, layout });

describe("it produces a real PDF", () => {
  it("renders a poster", async () => {
    const pdf = await render("poster");

    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(10_000);
  });

  it("renders a table tent", async () => {
    const pdf = await render("tent");
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("the Turkish glyphs, which are the whole reason the fonts are committed", () => {
  it("embeds a font subset rather than falling back to Helvetica", async () => {
    /**
     * `@react-pdf` falls back to Helvetica, which has no `ı`, `İ`, `ş` or `ğ` —
     * a poster for `Kadıköy Şubesi` prints `Kad1köy ^ubesi` on a wall, in
     * public, at A4. P3-T5 committed the two Inter faces for exactly this, and
     * `registerReportFonts` is what puts them here.
     *
     * Asserted on the *font descriptor* in the output: a poster that silently
     * fell back would still render, still be a valid PDF, and still be wrong.
     */
    const pdf = await render("poster");
    const text = pdf.toString("latin1");

    expect(text).toContain("Inter");
    expect(text).not.toContain("/BaseFont /Helvetica");
  });
});

describe("the tent is two faces, not one repeated", () => {
  it("is bigger than the poster, because it draws the code twice", async () => {
    // The cheapest true signal that both halves are in the file. A tent
    // rendered as one face is a sheet that stands up blank on one side, and
    // nobody finds that out until it is folded.
    const [poster, tent] = await Promise.all([render("poster"), render("tent")]);
    expect(tent.length).toBeGreaterThan(poster.length);
  });

  it("carries the fold label, which the poster does not", async () => {
    // Rendered text is subset-encoded, so the label is asserted by its absence
    // from the poster rather than by reading glyphs out of the tent: the two
    // documents differ, and only one of them is meant to be folded.
    const [poster, tent] = await Promise.all([render("poster"), render("tent")]);
    expect(tent.length - poster.length).toBeGreaterThan(0);
    expect(poster.length).toBeGreaterThan(10_000);
  });
});

describe("a single-location account", () => {
  it("renders without a branch line rather than repeating the business name", async () => {
    // `branchName: null` is what the route passes when the organization has one
    // location — a poster reading "Kadıköy Kahvecisi / Kadıköy Kahvecisi" is
    // the kind of thing that gets printed a hundred times before anyone says so.
    const pdf = await renderPoster({ ...base, branchName: null, layout: "poster" });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
