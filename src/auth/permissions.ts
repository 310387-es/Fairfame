import { createAccessControl } from "better-auth/plugins/access";

/**
 * Role definitions for the organization plugin.
 *
 * Four roles, per the build plan: owner / admin / member / client.
 * `client` is the agency-facing read-only role — an agency's customer who may
 * see their own reviews but must not touch billing, team, or connections.
 *
 * Permissions are checked server-side. The UI mirrors them; it never decides.
 */

const statement = {
  // Resources the Phase 0 slice actually has. Extend as features land.
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  location: ["create", "read", "update", "delete"],
  connection: ["create", "read", "delete"],
  review: ["read", "reply"],
  billing: ["read", "manage"],
} as const;

export const ac = createAccessControl(statement);

/** Full control, including billing and deleting the organization. */
export const owner = ac.newRole({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  location: ["create", "read", "update", "delete"],
  connection: ["create", "read", "delete"],
  review: ["read", "reply"],
  billing: ["read", "manage"],
});

/** Runs the account day to day, but cannot delete it or change what it pays. */
export const admin = ac.newRole({
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  location: ["create", "read", "update", "delete"],
  connection: ["create", "read", "delete"],
  review: ["read", "reply"],
  billing: ["read"],
});

/** Does the actual work: reads and replies. No destructive or commercial acts. */
export const member = ac.newRole({
  location: ["read"],
  connection: ["read"],
  review: ["read", "reply"],
});

/** Agency's end customer: sees their reviews, changes nothing. */
export const client = ac.newRole({
  location: ["read"],
  review: ["read"],
});

export const roles = { owner, admin, member, client } as const;

export const ROLE_KEYS = ["owner", "admin", "member", "client"] as const;
export type Role = (typeof ROLE_KEYS)[number];

/** Ascending authority. Useful for "at least admin"-style checks. */
const ROLE_RANK: Record<Role, number> = { client: 0, member: 1, admin: 2, owner: 3 };

export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function isRole(value: string): value is Role {
  return (ROLE_KEYS as readonly string[]).includes(value);
}
