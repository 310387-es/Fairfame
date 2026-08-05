# Inter

`Inter-Regular.ttf` and `Inter-SemiBold.ttf` are Inter, by Rasmus Andersson,
licensed under the **SIL Open Font License 1.1** — <https://openfontlicense.org>.
The OFL permits bundling and redistribution with software, including
commercially, provided the font is not sold on its own and the licence travels
with it. That is what this file is.

Upstream: <https://github.com/rsms/inter>

## Why these files are in the repository

They are the report's typeface (`src/reports/fonts.ts`), and every alternative
to committing them failed:

- **PDF's built-in Helvetica has no Turkish glyphs.** Rendered and looked at,
  "Kadıköy Şubesi" came out as "Kad1köy ^ubesi".
- **`@fontsource/inter` splits Turkish across two subset files.** Google's
  `latin` carries `ı ç ö ü` and `latin-ext` carries `İ ş Ş ğ Ğ`; neither alone
  can set a Turkish sentence, and `Font.register` takes one file per weight.
  Measured with `fontkit`, not assumed.
- **`@expo-google-fonts/inter` ships the unsubsetted TTFs and works** — but the
  path to them has to be resolved at runtime, and Turbopack rewrites
  `require.resolve` into a module id, so the app build fails whichever way the
  specifier is written.

A committed file has no resolution step to break. These are the 400 and 600
weights only, which is what the report uses.
