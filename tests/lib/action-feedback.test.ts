import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { invalidInput, toFieldErrors } from "@/server/action-result";
import { z } from "zod";

/**
 * No form fails silently (W1.5).
 *
 * **The bug.** Every call site decided for itself what to do with a server
 * action's result. Most caught a failure into a local `useState<string | null>`
 * and rendered it somewhere near the button; several ignored the result
 * entirely; **none of them said anything at all on success**. A form that
 * quietly worked and a form that quietly failed looked identical, which is why
 * the audit's tester submitted the same campaign twice and ended up with a
 * doubled name.
 *
 * A per-component fix would have been undone by the next component. So this
 * file does what `outbound-consent.test.ts` does for the consent gate:
 * **enumerates every component that can call a server action from disk**, and
 * requires each one to report through `useAction`. A new screen that goes back
 * to swallowing results has to be added to the exemption list below, with a
 * reason — which is the point. A list that can be edited silently is not a
 * rule; a list that must be argued with is.
 */

const ROOTS = ["src/components", "src/app"];

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else if (path.endsWith(".tsx") || path.endsWith(".ts")) found.push(path);
  }
  return found;
}

/** Every file that imports something from a `"use server"` module. */
function callsServerActions(): { path: string; source: string }[] {
  return (
    ROOTS.flatMap((root) => walk(root))
      .map((path) => ({ path: relative(process.cwd(), path), source: readFileSync(path, "utf8") }))
      .filter(({ source }) => /from "@\/server\/[a-z-]+"/.test(source))
      // A server component importing an action to *pass down* is not a call site;
      // only a client component can receive a result and show it.
      .filter(({ source }) => source.includes('"use client"'))
  );
}

/**
 * Call sites that deliberately do not report through `useAction`, and why.
 *
 * Each of these is a read rather than a mutation: nothing is changed, so there
 * is no outcome to confirm, and a toast on every keystroke or poll would be the
 * opposite of feedback. **A mutation must never appear here.**
 */
const EXEMPT: Record<string, string> = {
  "src/components/shell/search-palette.tsx":
    "Reads search results as you type. A toast per keystroke is not feedback.",
  "src/components/reviews/live-refresh.tsx":
    "Polls for new reviews on a timer. Nobody asked, so nobody is told.",
  "src/components/shell/notification-bell.tsx":
    "Reads the feed and marks it read; the badge and the list are the confirmation.",
  "src/components/reviews/template-picker.tsx":
    "Reads the template list to fill a menu. The menu opening is the result.",
  "src/components/digest/action-card.tsx":
    "Toggles a checkbox that is its own confirmation, and reverts on failure.",
  "src/components/shell/user-menu.tsx":
    "Switching organization navigates; the whole shell changing says it worked.",
  "src/components/contacts/segment-row.tsx":
    "Deletes a chip that vanishes on success — via useAction, which reports failures.",
};

describe("every component that runs a server action reports the result", () => {
  const sites = callsServerActions();

  it("finds the call sites at all", () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(sites.length).toBeGreaterThan(20);
  });

  it("routes each one through useAction, or names why not", () => {
    const silent = sites
      .filter(({ source }) => !source.includes("useAction"))
      .map(({ path }) => path)
      .filter((path) => EXEMPT[path] === undefined);

    expect(silent).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption for a file that no longer calls an action, or no longer
    // exists, is a stale argument nobody re-made. Delete it.
    const paths = new Set(sites.map((site) => site.path));
    const stale = Object.keys(EXEMPT).filter((path) => !paths.has(path));

    expect(stale).toEqual([]);
  });

  it("leaves no component catching a failure into a variable of its own", () => {
    // The exact shape this work package removed. Its return would mean two
    // places a failure can be reported and one of them off-screen.
    const local = sites
      .filter(({ source }) => /const \[error, setError\] = useState<string \| null>/.test(source))
      .map(({ path }) => path);

    expect(local).toEqual([]);
  });
});

describe("a schema failure names the field", () => {
  const schema = z.object({
    name: z.string().min(1, "Give it a name."),
    url: z.url("That is not a web address."),
    nested: z.object({ deep: z.string() }).optional(),
  });

  it("keys messages by the control the reader can go and fix", () => {
    const parsed = schema.safeParse({ name: "", url: "not-a-url" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    expect(toFieldErrors(parsed.error)).toEqual({
      name: "Give it a name.",
      url: "That is not a web address.",
    });
  });

  it("reports a nested issue against the field it belongs to", () => {
    // `nested.deep` is not the name of any input. The control somebody can
    // actually correct is `nested`, so that is what carries the message.
    const parsed = schema.safeParse({ name: "x", url: "https://a.test", nested: { deep: 1 } });
    if (parsed.success) throw new Error("expected a failure");

    expect(Object.keys(toFieldErrors(parsed.error))).toEqual(["nested"]);
  });

  it("shows one message per field, not three", () => {
    const strict = z.object({
      code: z.string().min(5, "Too short.").regex(/^\d+$/, "Digits only."),
    });
    const parsed = strict.safeParse({ code: "ab" });
    if (parsed.success) throw new Error("expected a failure");

    expect(Object.keys(toFieldErrors(parsed.error))).toHaveLength(1);
  });

  it("carries both halves, so a summary cannot ship without the detail", () => {
    const parsed = schema.safeParse({ name: "", url: "nope" });
    if (parsed.success) throw new Error("expected a failure");

    const result = invalidInput(parsed.error);

    expect(result.ok).toBe(false);
    expect(result.error.length).toBeGreaterThan(0);
    expect(Object.keys(result.fieldErrors)).toContain("name");
  });
});

describe("the server side has no discarded validation left", () => {
  it("returns field errors from every schema failure", () => {
    const actions = walk("src/server")
      .map((path) => ({ path: relative(process.cwd(), path), source: readFileSync(path, "utf8") }))
      .filter(({ path }) => !path.endsWith("action-result.ts"));

    // The shape this replaced: a `safeParse` failure answered with a bare
    // sentence, throwing away the one thing Zod knew — which field.
    const discarding = actions
      .filter(({ source }) =>
        /if \(!\w+\.success\)[\s\S]{0,80}?return \{\s*ok: false,\s*error:/.test(source),
      )
      .map(({ path }) => path);

    expect(discarding).toEqual([]);
  });
});

/**
 * A22-B3 — the browser must not answer for us.
 *
 * `required` on a control inside a `useAction` form blocks the submit *before*
 * the action runs, so the whole reporting path above never happens. Observed on
 * the campaign form: pressing the button with an empty name moved focus and
 * said nothing at all — the browser's own bubble is unreliable inside a dialog,
 * and when it does appear it is neither in the product's voice nor in the
 * product's language.
 *
 * `aria-required` keeps the promise to assistive technology and lets the
 * failure come back through the one path every other failure uses, which puts
 * a sentence under the field and moves focus to it.
 *
 * **A `Select` is exempt**, and deliberately: Radix renders a hidden native
 * select whose `required` cannot fire, because these are all defaulted and can
 * never be empty. The check therefore looks at `Input` and `Textarea` only.
 */
describe("validation is reported by the product, not by the browser", () => {
  it("has no native `required` on a field inside a form that reports through useAction", () => {
    const offenders = callsServerActions()
      .filter(({ source }) => source.includes("useAction("))
      .filter(({ source }) => {
        // Each `<Input …>` / `<Textarea …>` opening tag, and whether its
        // attributes carry a bare `required`. Deliberately naive: a regex that
        // over-reports here costs one comment, and one that under-reports costs
        // a silent form.
        const tags = source.match(/<(?:Input|Textarea)\b[^>]*>/g) ?? [];
        return tags.some((tag) => /(?:^|\s)required(?:\s|\/|>|=\{true\})/.test(tag));
      })
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
