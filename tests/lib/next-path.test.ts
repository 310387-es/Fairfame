import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/auth/next-path";

/**
 * The one rule shared by the sign-in and sign-up forms and by the guard that
 * bounces an already-signed-in visitor off those pages. It decides where the
 * product is willing to send somebody who has just authenticated — so the
 * cases that matter here are the ones it must *refuse*.
 */
describe("safeNextPath", () => {
  it("honours a same-origin path", () => {
    expect(safeNextPath("/invite/abc")).toBe("/invite/abc");
    expect(safeNextPath("/reviews?status=open")).toBe("/reviews?status=open");
    expect(safeNextPath("/")).toBe("/");
  });

  it("returns null for nothing at all", () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath("")).toBeNull();
  });

  it("refuses an absolute URL", () => {
    expect(safeNextPath("https://evil.test")).toBeNull();
    expect(safeNextPath("http://evil.test/reviews")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
  });

  it("refuses a protocol-relative URL, which is a host wearing a path's clothes", () => {
    expect(safeNextPath("//evil.test")).toBeNull();
    expect(safeNextPath("//evil.test/reviews")).toBeNull();
  });

  it("refuses a backslash in the second position, because browsers read it as a slash", () => {
    expect(safeNextPath("/\\evil.test")).toBeNull();
    expect(safeNextPath("/\\/evil.test")).toBeNull();
  });
});
