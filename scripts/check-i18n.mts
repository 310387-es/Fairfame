/**
 * Translation parity and dead-string check.
 *
 * Two failures this catches, both of which are invisible until a user hits them:
 *
 *   1. A key defined in one locale and missing in another. `next-intl` throws
 *      when a message is absent, so the Turkish build works, the English one
 *      crashes on that screen, and nobody notices until a customer switches
 *      language.
 *   2. A key nothing references. Dead strings cost translator time and describe
 *      behaviour the product no longer has.
 *
 * Run with `pnpm check:i18n`. Part of `pnpm check`, so CI enforces it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const MESSAGES_DIR = "src/i18n/messages";
const SOURCE_DIRS = ["src"];
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

type Messages = Record<string, unknown>;

/** `home.kpi.rating.label` — the shape `t()` is called with. */
function flatten(node: Messages, prefix = ""): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === "object" ? flatten(value as Messages, path) : [path];
  });
}

function readLocales(): Map<string, string[]> {
  const locales = new Map<string, string[]>();

  for (const file of readdirSync(MESSAGES_DIR).sort()) {
    if (!file.endsWith(".json")) continue;
    const locale = file.replace(/\.json$/, "");
    const parsed = JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf8")) as Messages;
    locales.set(locale, flatten(parsed));
  }

  return locales;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "messages" ? [] : sourceFiles(path);
    return SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

const source = SOURCE_DIRS.flatMap(sourceFiles)
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

/**
 * Namespaces reached with a template literal, e.g. ``t(`newItem.${type}`)`` or
 * ``getTranslations(`home.${section}`)``. Every key beneath one of these is
 * treated as used, because no static check can know which branch runs.
 */
const dynamicPrefixes = [...source.matchAll(/[`"']([\w.]*?)\.?\$\{/g)]
  .map((match) => match[1])
  // A type predicate, because `filter(Boolean)` does not narrow away
  // `undefined` — the compiler caught this, which is the point of running it.
  .filter((prefix): prefix is string => Boolean(prefix));

/** Literal namespaces and keys: `useTranslations("home.kpi")`, `t("title")`. */
const literals = new Set([...source.matchAll(/["'`]([\w][\w.]*)["'`]/g)].map((match) => match[1]!));

function isUsed(key: string): boolean {
  // Any suffix of the key may be the literal passed to `t()`, because the
  // namespace is bound separately by `useTranslations`.
  const segments = key.split(".");
  for (let start = 0; start < segments.length; start += 1) {
    if (literals.has(segments.slice(start).join("."))) return true;
  }

  return dynamicPrefixes.some(
    (prefix) => key === prefix || key.startsWith(`${prefix}.`) || prefix.endsWith(segments[0]!),
  );
}

const locales = readLocales();
if (locales.size < 2) {
  console.error(`Expected at least two locales in ${MESSAGES_DIR}.`);
  process.exit(1);
}

const problems: string[] = [];

// 1. Parity. Compared against the union, so neither locale is "the source of
//    truth" — a key added only to English is as much a bug as one added only to
//    Turkish.
const union = new Set([...locales.values()].flat());
for (const [locale, keys] of locales) {
  const owned = new Set(keys);
  const missing = [...union].filter((key) => !owned.has(key)).sort();
  if (missing.length > 0) {
    problems.push(
      `${relative(".", MESSAGES_DIR)}/${locale}.json is missing ${missing.length} key(s):\n` +
        missing.map((key) => `    ${key}`).join("\n"),
    );
  }
}

// 2. Dead strings. Reported once against the union rather than per locale.
const unused = [...union].filter((key) => !isUsed(key)).sort();
if (unused.length > 0) {
  problems.push(
    `${unused.length} translation key(s) are defined but never used:\n` +
      unused.map((key) => `    ${key}`).join("\n"),
  );
}

if (problems.length > 0) {
  console.error(`\n${problems.join("\n\n")}\n`);
  process.exit(1);
}

const [first] = [...locales.keys()];
console.log(
  `i18n ok — ${locales.size} locales, ${locales.get(first!)!.length} keys, all present and used.`,
);
