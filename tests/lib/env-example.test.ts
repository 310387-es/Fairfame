import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENV_KEYS } from "@/lib/env";

/**
 * `.env.example` and the schema say the same thing.
 *
 * A completeness test in the sense `docs/16` means: enumerated from disk, and
 * failing when the list grows. Nobody's build breaks when the two drift — the
 * app boots fine without a variable it has a default for, and a documented
 * variable nothing reads is just a line — so drift is only ever discovered by
 * somebody setting up the project and finding that the thing they configured
 * had no effect.
 *
 * Which is how this was found. `pnpm mock:platform` printed four base URLs to
 * copy into `.env` — three for the fake Google, one for the fake Meta — and not
 * one of them existed in the schema or was read anywhere in `src/`. The clients
 * took the base URL as a constructor option that only tests ever passed, so
 * following `CLAUDE.md`'s "point the connectors' base URLs at it" sent them at
 * the real Google and the real Graph API, with credentials that could not work
 * there. A quiet failure that looks like a broken connector.
 */

const EXAMPLE = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");

/** Both `KEY=` and a commented-out `# KEY=` count as documented. */
function keysIn(source: string): string[] {
  return [...source.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!);
}

/**
 * Variables `.env.example` carries that the app itself never reads.
 *
 * `docker-compose.yml` and `docker/postgres/init/01-app-role.sh` create the
 * `NOBYPASSRLS` application role from these, so they belong in the same file a
 * developer fills in — they are simply consumed by Docker rather than by Zod.
 */
const NOT_READ_BY_THE_APP = new Set(["APP_DB_USER", "APP_DB_PASSWORD"]);

describe(".env.example documents the environment", () => {
  const documented = new Set(keysIn(EXAMPLE));

  it.each(ENV_KEYS)("%s is documented", (key) => {
    expect(
      documented.has(key),
      `${key} is in the env schema and not in .env.example. Add it there with a line ` +
        "saying what it does and what absent means; a variable nobody can discover is a " +
        "variable nobody sets.",
    ).toBe(true);
  });

  it("documents nothing the app does not read", () => {
    const schema = new Set(ENV_KEYS);
    const orphans = [...documented].filter(
      (key) => !schema.has(key) && !NOT_READ_BY_THE_APP.has(key),
    );

    expect(
      orphans,
      "These are documented in .env.example and read by nothing. Either wire them up or " +
        "delete the lines — a variable that looks configurable and is not is worse than " +
        "an undocumented one, because setting it looks like it worked.",
    ).toEqual([]);
  });

  it("does not tell anyone to set a variable that does not exist", () => {
    // `pnpm mock:platform` prints lines meant to be pasted into `.env`. It is
    // the only script that does, and it is where this class of bug came from.
    const script = readFileSync(
      new URL("../../scripts/mock-platform.mts", import.meta.url),
      "utf8",
    );
    const printed = [...script.matchAll(/`\s*([A-Z][A-Z0-9_]*)=\$\{/g)].map((match) => match[1]!);

    expect(
      printed.length,
      "the script stopped printing variables — has it been rewritten?",
    ).toBeGreaterThan(0);

    for (const key of printed) {
      expect(ENV_KEYS, `mock:platform prints ${key}=, which the app never reads`).toContain(key);
    }
  });
});
