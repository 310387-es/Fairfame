import { join } from "node:path";
import { Font } from "@react-pdf/renderer";

/**
 * The report's typeface (P3-T5), and why it is a committed file.
 *
 * **This is not decoration — it is the difference between a report a Turkish
 * business can read and one it cannot.** `@react-pdf/renderer` falls back to
 * PDF's built-in Helvetica, which has no Turkish glyphs at all: rendered and
 * looked at in a viewer, "Kadıköy Şubesi" came out as "Kad1köy ^ubesi". Every
 * dotless ı, every ş and ğ, mangled, in a document mailed to a customer.
 *
 * Three attempts, each measured with `fontkit` rather than guessed:
 *
 *   - Helvetica (the default): missing every Turkish letter.
 *   - `@fontsource/inter`, the obvious npm choice: **its subsets are split down
 *     the middle of Turkish.** Google's `latin` subset carries `ı ç ö ü`;
 *     `latin-ext` carries `İ ş Ş ğ Ğ`. Neither file alone can set a Turkish
 *     sentence, and `Font.register` takes one file per weight — there is no
 *     glyph fallback between registered faces.
 *   - `@expo-google-fonts/inter`: unsubsetted TTFs, all of it in one file, and
 *     correct. But the path has to be resolved at runtime, and **Turbopack
 *     rewrites `require.resolve` into a numeric module id**, so the app build
 *     broke whichever way the specifier was written: spelled out, it tried to
 *     treat the `.ttf` as a module; narrowed to `package.json`, `dirname()`
 *     received a number; assembled from parts, it refused as "too dynamic".
 *
 * So the files are committed, next to this one, with their licence. There is no
 * resolution step left to break — in the Next server or in the worker — and the
 * font a customer's report is set in is a file somebody can open.
 *
 * **No star glyph anywhere.** `★` (U+2605) is absent from every font checked,
 * including the ones that pass everything else, so the report writes "4,3 / 5"
 * rather than a rating with a star in it. A content decision forced by a
 * measurement, not a style preference.
 */

export const REPORT_FONT = "Inter";

/**
 * Relative to the project root, which is where all three processes that render
 * a report are started from — `next dev`, `next start` and `pnpm worker`.
 */
const FONT_DIR = join(process.cwd(), "src", "reports", "fonts");

/**
 * Registered once per process, not once per render.
 *
 * `Font.register` mutates a module-level registry, and the worker renders a
 * report per schedule per week — re-registering on every one would re-parse the
 * TTFs each time for no gain.
 */
let registered = false;

export function registerReportFonts(): void {
  if (registered) return;

  Font.register({
    family: REPORT_FONT,
    fonts: [
      { src: join(FONT_DIR, "Inter-Regular.ttf"), fontWeight: 400 },
      { src: join(FONT_DIR, "Inter-SemiBold.ttf"), fontWeight: 600 },
    ],
  });

  // Hyphenation off. `@react-pdf` ships an English hyphenation dictionary and
  // applies it to every language, which breaks Turkish words in places Turkish
  // does not break them — and a report is read, not typeset.
  Font.registerHyphenationCallback((word) => [word]);

  registered = true;
}
