import { describe, expect, it } from "vitest";
import { isRole, roleAtLeast, ROLE_KEYS, roles, type Role } from "@/auth/permissions";

describe("roles", () => {
  it("defines exactly the four roles from the build plan", () => {
    expect([...ROLE_KEYS]).toEqual(["owner", "admin", "member", "client"]);
    expect(Object.keys(roles).sort()).toEqual([...ROLE_KEYS].sort());
  });

  it("recognises valid roles and rejects anything else", () => {
    for (const role of ROLE_KEYS) {
      expect(isRole(role)).toBe(true);
    }
    expect(isRole("superuser")).toBe(false);
    expect(isRole("")).toBe(false);
    // Guards against a database value that a migration might introduce later.
    expect(isRole("OWNER")).toBe(false);
  });
});

describe("roleAtLeast", () => {
  const ascending: Role[] = ["client", "member", "admin", "owner"];

  it("is reflexive — a role always satisfies itself", () => {
    for (const role of ascending) {
      expect(roleAtLeast(role, role)).toBe(true);
    }
  });

  it("lets higher roles satisfy lower requirements", () => {
    for (let i = 0; i < ascending.length; i += 1) {
      for (let j = 0; j <= i; j += 1) {
        const actual = ascending[i] as Role;
        const required = ascending[j] as Role;
        expect(roleAtLeast(actual, required), `${actual} should satisfy ${required}`).toBe(true);
      }
    }
  });

  it("never lets a lower role satisfy a higher requirement", () => {
    for (let i = 0; i < ascending.length; i += 1) {
      for (let j = i + 1; j < ascending.length; j += 1) {
        const actual = ascending[i] as Role;
        const required = ascending[j] as Role;
        expect(roleAtLeast(actual, required), `${actual} must not satisfy ${required}`).toBe(false);
      }
    }
  });

  it("keeps client strictly below member — the agency read-only role", () => {
    // The client role exists so an agency's customer can see their reviews
    // without being able to act. If this ever inverted, they could reply.
    expect(roleAtLeast("client", "member")).toBe(false);
    expect(roleAtLeast("member", "client")).toBe(true);
  });
});
