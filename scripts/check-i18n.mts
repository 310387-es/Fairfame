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

/**
 * Every source file, minus the catalogues themselves.
 *
 * Excluded **by path, not by name**. An earlier version skipped any directory
 * called `messages`, which was fine while `src/i18n/messages` was the only one
 * — and then P4-T3 added `src/app/(app)/messages` and `src/components/messages`
 * and eleven live keys were reported as dead. A name match here is a rule about
 * every directory anybody ever adds; a path match is a rule about the one
 * directory that is genuinely not source.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === MESSAGES_DIR ? [] : sourceFiles(path);
    return SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

/**
 * Source with its comments taken out.
 *
 * **A doc comment is not code, and this script could not tell.** `useAction`'s
 * own documentation shows the idiomatic call — `success: t("created")` — inside
 * a block comment. The moment that file gained a real `useTranslations(...)`
 * binding, the example was read as a live call and `validation.created` was
 * reported as a key used in code and defined in no locale. It fails in the
 * harmless direction here, but the same blindness runs the other way: a key
 * that exists *only* in a comment counts as used, and keeps a dead string alive
 * in both catalogues forever.
 *
 * Comments are replaced with whitespace rather than removed, so nothing on
 * either side of one is joined into a token that was never written.
 *
 * A regex cannot parse JavaScript, and this one does not try: a `//` inside a
 * string literal (a URL, most often) would be mistaken for a comment. That is
 * why the string-literal alternation comes **first** — a matched string is
 * returned untouched, so `"https://example.com"` survives and the comment after
 * it does not. Fourth fix to this script found by using it, and each one has
 * been a case of a pattern matching more than it meant to.
 */
function withoutComments(text: string): string {
  return text.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, literal: string | undefined) => literal ?? match.replace(/[^\n]/g, " "),
  );
}

const source = SOURCE_DIRS.flatMap(sourceFiles)
  .map((file) => withoutComments(readFileSync(file, "utf8")))
  .join("\n");

/**
 * Namespaces reached with a template literal, e.g. ``t(`newItem.${type}`)`` or
 * ``getTranslations(`home.${section}`)``. Every key beneath one of these is
 * treated as used, because no static check can know which branch runs.
 */
const dynamicPrefixes: string[] = [...source.matchAll(/[`"']([\w.]*?)\.?\$\{/g)]
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

  return [...dynamicPrefixes, ...dynamicNamespaces].some(
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
/**
 * The mirror check: a key *used* in code that is defined nowhere (W2.1).
 *
 * The two checks above catch a key missing from one locale, and a key defined
 * in every locale but used nowhere. Neither catches the third case — a `t("x")`
 * where `x` exists in no locale — and that is the one a customer sees, because
 * `next-intl` renders the key itself. `digest.starLabel` shipped that way and
 * the suite stayed green.
 *
 * **Namespace-aware, and it has to be.** The first attempt matched a bare
 * suffix against every key, which reported `digest.starLabel` as fine because
 * an unrelated `widget.starLabel` existed — precisely the bug it was written to
 * catch. So each file's `const t = useTranslations("digest")` bindings are read
 * first, and `t("starLabel")` is then checked against `digest.starLabel` and
 * nothing else.
 *
 * What it still cannot see: a translator whose namespace is computed, or one
 * passed between functions. Those fall back to being ignored rather than
 * guessed at — a false alarm in this check would train people to skip it.
 *
 * **A namespace called with a non-literal key is treated as wholly dynamic**
 * (W3.2). `themeLabel` renders a canonical theme with `tThemes(key)`, where
 * `key` is a variable holding one of fifteen taxonomy keys — none of which
 * appears as a literal anywhere. Without this the whole `themes.*` catalogue
 * reported as dead and the only fixes available were to delete real labels or
 * to write a fifteen-branch switch whose sole purpose was to be seen by a
 * regex. The template-literal form below (`t(\`lever.${x}\`)`) was already
 * handled; this is the same idea for the bare-variable form.
 *
 * **It only silences the *dead-key* half, and that distinction is load-bearing**
 * (W4.1). A dynamic call means we cannot know which keys are *reached*, so a
 * key under that namespace must not be reported as dead. It says nothing about
 * a key spelled out as a literal — that one is knowable, and skipping it let
 * `t("anonymous")` and `t("overdue")` ship against a namespace that had
 * neither, in both locales, with this check passing. Two blank strings on the
 * busiest screen in the product, found in a browser console rather than here.
 */
const BINDING =
  /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:use|get)Translations\(\s*["']([\w.]+)["']/g;

/**
 * The destructured form, which is how most pages actually bind (W4.1):
 *
 *     const [t, format, actor] = await Promise.all([
 *       getTranslations("inbox"),
 *       getFormatter(),
 *       requireActor(),
 *     ]);
 *
 * `BINDING` above cannot see through this, so **every call in such a file was
 * skipped** — the file contributed no namespaces, and the loop below `continue`s
 * on an empty map. That is not a small gap: `/reviews` is the busiest screen in
 * the product and it was never checked, which is how `t("anonymous")` and
 * `t("overdue")` shipped against a namespace that had neither.
 *
 * Matched positionally, and only where the entry really is a `getTranslations`
 * call — `getFormatter()` and `requireActor()` sit in the same array and must
 * not be bound to anything.
 */
const DESTRUCTURED =
  /(?:const|let)\s*\[([^\]]+)\]\s*=\s*await\s+Promise\.all\(\s*\[([\s\S]*?)\]\s*\)/g;
const CALL = /\b(\w+)\(\s*["']([\w][\w.]*)["']\s*[,)]/g;
/** `tThemes(key)` / `tThemes(key as Foo)` — a call whose key is not a literal. */
const DYNAMIC_CALL = /\b(\w+)\(\s*(?!["'`])[A-Za-z_$][\w$]*/g;

const undefinedKeys = new Set<string>();
/** Namespaces reached by a computed key — see the note above. */
const dynamicNamespaces: string[] = [];

for (const file of SOURCE_DIRS.flatMap(sourceFiles)) {
  const text = withoutComments(readFileSync(file, "utf8"));

  /**
   * One name may be bound to **several** namespaces in one file (W4.4).
   *
   * A `Map<name, namespace>` was silently last-write-wins, and two components
   * in one file — `const t = getTranslations("insights.histogram")` in the
   * first, `const t = getTranslations("insights.percentiles")` in the second —
   * meant every `t(...)` in the file was checked against whichever binding the
   * regex happened to see last. That produced a false *failure* here, which is
   * the harmless direction; the dangerous one is a false *pass*, and it is just
   * as reachable: `t("title")` under the wrong namespace resolves happily when
   * both namespaces have a `title`.
   *
   * A regex cannot see scopes, so the honest answer is a **set**: a key counts
   * as defined if it exists under any namespace that name is bound to. That is
   * the conservative direction — it can under-report a genuinely missing key in
   * a file with two translators, and it can never fail a key that plainly
   * exists, which is what would teach people to work around the check rather
   * than trust it.
   */
  const namespaces = new Map<string, Set<string>>();
  const bind = (name: string, namespace: string) => {
    const bound = namespaces.get(name) ?? new Set<string>();
    bound.add(namespace);
    namespaces.set(name, bound);
  };

  for (const match of text.matchAll(BINDING)) bind(match[1]!, match[2]!);

  for (const [, names, entries] of text.matchAll(DESTRUCTURED)) {
    const bound = names!.split(",").map((name) => name.trim());
    // Split on top-level commas only: an entry is `getTranslations("a.b")` or
    // some other promise, and neither contains a bracketed comma in practice.
    entries!
      .split(/,(?![^(]*\))/)
      .map((entry) => entry.trim())
      .forEach((entry, index) => {
        const match = /^(?:use|get)Translations\(\s*["']([\w.]+)["']/.exec(entry);
        const name = bound[index];
        if (match && name) bind(name, match[1]!);
      });
  }
  if (namespaces.size === 0) continue;

  // A namespace whose translator is ever called with a computed key: every key
  // beneath it is reachable, so none of them may be reported as dead. Kept in
  // its own list, because it must *not* excuse a literal call to a key that
  // does not exist — see the note above.
  for (const [, name] of text.matchAll(DYNAMIC_CALL)) {
    for (const namespace of namespaces.get(name!) ?? []) dynamicNamespaces.push(namespace);
  }

  for (const [, name, key] of text.matchAll(CALL)) {
    const bound = namespaces.get(name!);
    if (!bound || bound.size === 0) continue;

    const candidates = [...bound].map((namespace) => `${namespace}.${key}`);
    // A dynamic prefix beneath any of them means the branch is unknowable.
    if (candidates.some((full) => dynamicPrefixes.some((prefix) => full.startsWith(prefix)))) {
      continue;
    }

    // Defined under *any* binding is defined: with two candidates we cannot
    // know which one the call meant, and failing a key that plainly exists
    // would make the check something people work around rather than trust.
    // (Dead-key detection is unaffected — `isUsed` reads the file's string
    // literals directly and never consulted this mapping.)
    if (candidates.some((full) => union.has(full))) continue;

    undefinedKeys.add(candidates[0]!);
  }
}

if (undefinedKeys.size > 0) {
  console.error(
    `${undefinedKeys.size} translation key(s) are used in code but defined in no locale:\n` +
      [...undefinedKeys]
        .sort()
        .map((key) => `    ${key}`)
        .join("\n"),
  );
  process.exitCode = 1;
}

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
