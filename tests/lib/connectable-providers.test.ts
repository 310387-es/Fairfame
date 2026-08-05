import { describe, expect, it } from "vitest";
import { describeConnectableProviders, describeProvider } from "@/connectors/capability-view";
import { PROVIDERS } from "@/connectors/providers";

/**
 * What the product offers a customer as a review source (W1.4).
 *
 * The audit's P0-2 and P0-8, which were the same bug wearing two hats: the
 * Locations screen listed **every provider in the registry**, so a business
 * being shown the product was invited to connect "Mock source", "Fixture
 * provider", and — worst — "WhatsApp Business", which declares `read: "none"`
 * and threw `Provider "whatsapp" cannot read reviews.` in English when pressed.
 *
 * These tests are about the *rule*, not about three names. A capability test
 * and a registry flag are what make the next outbound-only or test-only
 * provider right by construction, and the last test here is the one that
 * notices when somebody adds one.
 */

describe("what a customer is offered", () => {
  const offered = describeConnectableProviders();
  const keys = offered.map((view) => view.provider);

  it("excludes a channel that cannot read reviews", () => {
    // WhatsApp is somewhere you message people, not somewhere reviews come
    // from. It gets a real home in W2.2; what it must not have is a connect
    // button on the screen for review sources.
    expect(keys).not.toContain("whatsapp");
    expect(offered.every((view) => view.capabilities.read !== "none")).toBe(true);
  });

  it("excludes the development connectors", () => {
    expect(keys).not.toContain("mock");
    expect(keys).not.toContain("fixture");
  });

  it("still offers the real sources", () => {
    // The exclusions have to be exclusions, not a filter that ate everything —
    // an empty list would pass all three tests above.
    expect(keys).toContain("google");
    expect(keys.length).toBeGreaterThan(0);
  });

  it("hands the development connectors back when asked", () => {
    // Hidden, not removed. `?dev=1` in a non-production build is how anybody
    // working on the product still connects one.
    const withDev = describeConnectableProviders({ includeDevOnly: true }).map(
      (view) => view.provider,
    );

    expect(withDev).toContain("mock");
    expect(withDev).toContain("fixture");
    // And the capability rule is not relaxed along with it: a dev flag is about
    // who is looking, not about what a provider can do.
    expect(withDev).not.toContain("whatsapp");
  });
});

describe("the registry stays the place these facts live", () => {
  it("marks every non-readable provider as such rather than naming it in the UI", () => {
    // If this fails, a provider has been given `read: "none"` and the fix is
    // not to special-case it anywhere — it is already excluded. The assertion
    // exists so the *reason* whatsapp disappears stays visible.
    const outbound = Object.values(PROVIDERS).filter(
      (descriptor) => descriptor.capabilities.read === "none",
    );

    expect(outbound.map((descriptor) => descriptor.key)).toContain("whatsapp");
  });

  it("declares every development connector on the descriptor", () => {
    // The list is the point, in the spirit of P3-T8's public-route enumeration:
    // a test connector added later has to be named here to be noticed, rather
    // than quietly appearing on a customer's Locations screen.
    const devOnly = Object.values(PROVIDERS)
      .filter((descriptor) => descriptor.devOnly === true)
      .map((descriptor) => descriptor.key)
      .sort();

    expect(devOnly).toEqual(["fixture", "mock"]);
  });

  it("keeps capabilities honest for a mocked provider", () => {
    // A mocked Google still declares Google's abilities — what an owner sees on
    // demo data is what they will see when the flag flips. This is why the
    // *badge* had to stop saying "Live sync": the capability was never the
    // thing that was untrue.
    const google = describeProvider("google");

    expect(google?.capabilities.read).toBe("full");
    expect(google?.devOnly).toBe(false);
  });
});
