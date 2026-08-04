import { describe, expect, it } from "vitest";
import { renderTemplate, TEMPLATE_VARIABLES } from "@/replies/template-vars";
import { orderForLanguage } from "@/replies/templates";

/**
 * Filling a template in (P2-T5).
 *
 * The substituted values include the reviewer's own name, which is untrusted
 * text on its way into a message published under the business's name. Most of
 * what follows is about that: what happens when the value is missing, and what
 * happens when it is chosen to look like the template syntax itself.
 */

describe("renderTemplate", () => {
  const context = { author: "Selin", location: "Kadıköy", business: "Kahve Dünyası" };

  it("substitutes every known variable", () => {
    expect(
      renderTemplate(
        "Merhaba {{author}}, {{location}} şubemize teşekkürler — {{business}}",
        context,
      ),
    ).toBe("Merhaba Selin, Kadıköy şubemize teşekkürler — Kahve Dünyası");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderTemplate("Merhaba {{ author }}", context)).toBe("Merhaba Selin");
  });

  it("substitutes a repeated variable everywhere it appears", () => {
    expect(renderTemplate("{{author}}, {{author}}", context)).toBe("Selin, Selin");
  });

  it("never expands a value that looks like a placeholder", () => {
    // A reviewer is called whatever they called themselves. Sequential replaces
    // would expand this on the next pass and leak the business name into a
    // greeting — the shape of every template-injection bug there has ever been.
    const hostile = { author: "{{business}}", business: "Kahve Dünyası" };

    expect(renderTemplate("Merhaba {{author}}", hostile)).toBe("Merhaba {{business}}");
  });

  it("closes the gap when a variable has no value", () => {
    // An anonymous reviewer must not produce "Merhaba ,".
    expect(renderTemplate("Merhaba {{author}}, teşekkürler.", { author: null })).toBe(
      "Merhaba, teşekkürler.",
    );
  });

  it("leaves an unknown variable exactly as written", () => {
    // The typo has to be visible in the composer. Silently blanking it would
    // send a half-written greeting to a customer.
    expect(renderTemplate("Merhaba {{autor}}", context)).toBe("Merhaba {{autor}}");
  });

  it("leaves ordinary text with braces alone", () => {
    expect(renderTemplate("Kod: {ABC} veya {{ }}", context)).toBe("Kod: {ABC} veya {{ }}");
  });

  it("knows exactly three variables", () => {
    // A closed set. Adding a fourth should be a deliberate act, and this test is
    // the thing that makes it one.
    expect([...TEMPLATE_VARIABLES]).toEqual(["author", "location", "business"]);
  });
});

describe("orderForLanguage", () => {
  const templates = [
    { name: "Teşekkür", language: "tr" },
    { name: "Thanks", language: "en" },
    { name: "Özür", language: "tr" },
  ];

  it("puts the review's own language first", () => {
    expect(orderForLanguage(templates, "en").map((entry) => entry.name)).toEqual([
      "Thanks",
      "Teşekkür",
      "Özür",
    ]);
  });

  it("keeps the rest rather than hiding them", () => {
    // A team with only Turkish templates should still be offered them on an
    // English review — hiding them would look like the feature is broken.
    expect(orderForLanguage(templates, "en")).toHaveLength(3);
  });

  it("matches on the base language of a regional tag", () => {
    expect(orderForLanguage(templates, "en-GB")[0]?.name).toBe("Thanks");
  });

  it("leaves the order alone when the review's language is unknown", () => {
    expect(orderForLanguage(templates, null).map((entry) => entry.name)).toEqual([
      "Teşekkür",
      "Thanks",
      "Özür",
    ]);
  });
});
