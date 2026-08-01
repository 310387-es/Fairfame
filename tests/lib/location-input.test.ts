import { describe, expect, it } from "vitest";
import { connectSourceSchema, parseCreateLocation, syncNowSchema } from "@/server/location-input";

/**
 * Regression tests for the location action inputs.
 *
 * The headline case is the FormData/null mismatch: `FormData.get()` returns
 * `null` for an absent field, so a `.optional()` schema rejects every
 * submission that leaves an optional input blank. That bug is unusually
 * dangerous because the symptom — the write silently not happening — is
 * indistinguishable from a permission or plan denial, which is exactly how it
 * was misread during manual verification.
 */

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("parseCreateLocation", () => {
  it("accepts a name on its own, with address and category absent", () => {
    const result = parseCreateLocation(form({ name: "Kadıköy Şubesi" }));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.name).toBe("Kadıköy Şubesi");
    expect(result.data.address).toBeNull();
    expect(result.data.category).toBeNull();
  });

  it("accepts every field filled in", () => {
    const result = parseCreateLocation(
      form({ name: "Beşiktaş", address: "Sinanpaşa Mah.", category: "restaurant" }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.address).toBe("Sinanpaşa Mah.");
    expect(result.data.category).toBe("restaurant");
  });

  it("treats blank optional fields as absent, not as empty strings", () => {
    const result = parseCreateLocation(form({ name: "Ataşehir", address: "", category: "   " }));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.address).toBeNull();
    expect(result.data.category).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    const result = parseCreateLocation(form({ name: "  Üsküdar  " }));
    expect(result.success && result.data.name).toBe("Üsküdar");
  });

  it("rejects a missing name", () => {
    expect(parseCreateLocation(form({})).success).toBe(false);
  });

  it("rejects a whitespace-only name", () => {
    expect(parseCreateLocation(form({ name: "   " })).success).toBe(false);
  });

  it("rejects an over-long name rather than truncating it", () => {
    expect(parseCreateLocation(form({ name: "a".repeat(121) })).success).toBe(false);
  });

  it("preserves Turkish characters exactly", () => {
    const result = parseCreateLocation(form({ name: "Şişli Çğıöü İstanbul" }));
    expect(result.success && result.data.name).toBe("Şişli Çğıöü İstanbul");
  });
});

describe("connectSourceSchema", () => {
  it("requires a uuid location", () => {
    expect(connectSourceSchema.safeParse({ locationId: crypto.randomUUID() }).success).toBe(true);
    expect(connectSourceSchema.safeParse({ locationId: "not-a-uuid" }).success).toBe(false);
    expect(connectSourceSchema.safeParse({}).success).toBe(false);
  });
});

describe("syncNowSchema", () => {
  it("requires a uuid connection", () => {
    expect(syncNowSchema.safeParse({ connectionId: crypto.randomUUID() }).success).toBe(true);
    expect(syncNowSchema.safeParse({ connectionId: "" }).success).toBe(false);
  });
});
