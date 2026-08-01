import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Phase 0 canonical schema.
 *
 * Conventions
 * -----------
 * - Every tenant-owned row carries `organization_id`. Row-Level Security and
 *   the tenant-scoped data layer land in T4; this file only declares shape.
 * - Primary keys are native `uuid`, defaulted by Postgres `gen_random_uuid()`.
 *   BetterAuth must therefore be configured with `advanced.database.generateId:
 *   "uuid"` in T5, which lets Postgres generate the id itself.
 * - Deleting an organization cascades to its tenant rows, which is what
 *   KVKK/GDPR erasure requires.
 * - Money is stored in integer minor units (cents), never floats.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const membershipRoleEnum = pgEnum("membership_role", ["owner", "admin", "member", "client"]);

export const planKeyEnum = pgEnum("plan_key", ["starter", "growth", "pro", "agency"]);

export const billingIntervalEnum = pgEnum("billing_interval", ["month", "year"]);

export const connectionStatusEnum = pgEnum("connection_status", [
  "pending",
  "active",
  "error",
  "disconnected",
]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
]);

export const consentTypeEnum = pgEnum("consent_type", ["kvkk", "iys"]);

// ---------------------------------------------------------------------------
// Shared column builders
// ---------------------------------------------------------------------------

const primaryId = () => uuid("id").primaryKey().defaultRandom();

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ---------------------------------------------------------------------------
// Plans & billing (not tenant-owned — `plans` is global catalog config)
// ---------------------------------------------------------------------------

export const plans = pgTable("plans", {
  id: primaryId(),
  key: planKeyEnum("key").notNull().unique(),
  name: text("name").notNull(),
  /**
   * Minor units of `currency` (kuruş for TRY). Null for Agency — quoted per deal.
   * Integer, never a float: money must not round.
   */
  priceMonth: integer("price_month"),
  /** ISO 4217. TRY for the launch market; USD/EUR plans come with Stripe later. */
  currency: text("currency").notNull().default("TRY"),
  interval: billingIntervalEnum("interval").notNull().default("month"),
  /** Feature flags, numeric limits and metered allowances. Config, not code. */
  entitlements: jsonb("entitlements").notNull(),
  providerPriceId: text("provider_price_id"),
  ...timestamps,
});

// ---------------------------------------------------------------------------
// Identity & tenancy
// ---------------------------------------------------------------------------

/** BetterAuth-managed core (T5), extended with `locale`. */
export const users = pgTable("users", {
  id: primaryId(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  locale: text("locale"),
  ...timestamps,
});

export const organizations = pgTable("organizations", {
  id: primaryId(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  planId: uuid("plan_id").references(() => plans.id, { onDelete: "set null" }),
  locale: text("locale").notNull().default("tr"),
  currency: text("currency").notNull().default("TRY"),
  /** Our own org configuration. */
  settings: jsonb("settings").notNull().default({}),
  /** BetterAuth's organization metadata — it stores stringified JSON here, so
   *  this is deliberately text and kept separate from `settings`. */
  metadata: text("metadata"),
  ...timestamps,
});

export const memberships = pgTable(
  "memberships",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRoleEnum("role").notNull().default("member"),
    ...timestamps,
  },
  (table) => [
    unique("memberships_organization_id_user_id_key").on(table.organizationId, table.userId),
    index("memberships_user_id_idx").on(table.userId),
    index("memberships_organization_id_idx").on(table.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// Tenant-owned business data
// ---------------------------------------------------------------------------

export const locations = pgTable(
  "locations",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    address: text("address"),
    category: text("category"),
    locale: text("locale"),
    ...timestamps,
  },
  (table) => [index("locations_organization_id_idx").on(table.organizationId)],
);

export const connections = pgTable(
  "connections",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    /** Connector provider key: 'mock' | 'google' | 'instagram' | ... */
    provider: text("provider").notNull(),
    status: connectionStatusEnum("status").notNull().default("pending"),
    /** Snapshot of the connector's Capability at connect time. */
    capabilities: jsonb("capabilities").notNull().default({}),
    /**
     * Non-secret, connector-specific settings (a Google place id, the mock's
     * drip interval). Credentials never go here — they belong in
     * `encrypted_tokens`. Not in the original Phase 0 table spec, but every
     * connector needs somewhere to keep its configuration.
     */
    config: jsonb("config").notNull().default({}),
    /** Encrypted at the application layer — never store plaintext credentials. */
    encryptedTokens: text("encrypted_tokens"),
    /** Opaque provider pagination/sync cursor. */
    cursor: text("cursor"),
    ...timestamps,
  },
  (table) => [
    index("connections_organization_id_idx").on(table.organizationId),
    index("connections_location_id_idx").on(table.locationId),
    unique("connections_location_id_provider_key").on(table.locationId, table.provider),
  ],
);

/**
 * Canonical review model. Every connector normalizes into this shape and the
 * untouched provider response is always retained in `raw_payload`.
 */
export const reviews = pgTable(
  "reviews",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceReviewId: text("source_review_id").notNull(),
    authorName: text("author_name"),
    rating: integer("rating"),
    text: text("text"),
    language: text("language"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    url: text("url"),
    rawPayload: jsonb("raw_payload").notNull(),
    ...timestamps,
  },
  (table) => [
    // Dedup key, scoped to the tenant. The build plan specifies
    // unique(source, source_review_id), but a global constraint breaks the
    // moment two organizations connect the same public place: the second
    // tenant's ingest would collide, silently lose reviews, and leak the
    // existence of another tenant's row. Dedup is only ever meaningful within
    // an organization, so organization_id leads the key.
    unique("reviews_org_source_source_review_id_key").on(
      table.organizationId,
      table.source,
      table.sourceReviewId,
    ),
    // Inbox listing: newest first, scoped to a location within a tenant.
    index("reviews_org_location_posted_at_idx").on(
      table.organizationId,
      table.locationId,
      table.postedAt.desc(),
    ),
    check("reviews_rating_range", sql`${table.rating} is null or ${table.rating} between 1 and 5`),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    status: subscriptionStatusEnum("status").notNull().default("trialing"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    /** Per-org entitlement overrides: comps, custom deals, grandfathering. */
    overrides: jsonb("overrides").notNull().default({}),
    ...timestamps,
  },
  (table) => [index("subscriptions_organization_id_idx").on(table.organizationId)],
);

export const usageCounters = pgTable(
  "usage_counters",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Metered entitlement key, e.g. 'sms_credits'. */
    metric: text("metric").notNull(),
    /** Billing period identifier, e.g. '2026-08'. */
    period: text("period").notNull(),
    count: integer("count").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    unique("usage_counters_organization_id_metric_period_key").on(
      table.organizationId,
      table.metric,
      table.period,
    ),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null when the actor is the system (a scheduled job, a webhook). */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entity: text("entity"),
    meta: jsonb("meta").notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [index("audit_logs_organization_id_at_idx").on(table.organizationId, table.at.desc())],
);

/** Stub for the İYS/KVKK consent gate that guards commercial messaging later. */
export const consentRecords = pgTable(
  "consent_records",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Pointer to the contact (phone/email hash or contact id) — not the PII itself. */
    contactRef: text("contact_ref").notNull(),
    type: consentTypeEnum("type").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    proofRef: text("proof_ref"),
    ...timestamps,
  },
  (table) => [
    index("consent_records_organization_id_idx").on(table.organizationId),
    unique("consent_records_org_contact_type_key").on(
      table.organizationId,
      table.contactRef,
      table.type,
    ),
  ],
);

// ---------------------------------------------------------------------------
// BetterAuth-managed tables (T5)
//
// Shapes are dictated by BetterAuth; src/auth/config.ts maps its singular model
// names onto these plural table names. Columns beyond BetterAuth's requirements
// are additive only — renaming or dropping one breaks auth at runtime, not at
// compile time.
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  "sessions",
  {
    id: primaryId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** Set by the organization plugin; the source of the request's tenant. */
    activeOrganizationId: uuid("active_organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: primaryId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    idToken: text("id_token"),
    /** Argon2/scrypt hash for the credential provider — never a plaintext password. */
    password: text("password"),
    ...timestamps,
  },
  (table) => [
    index("accounts_user_id_idx").on(table.userId),
    unique("accounts_provider_id_account_id_key").on(table.providerId, table.accountId),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    id: primaryId(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: membershipRoleEnum("role").notNull().default("member"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [
    index("invitations_organization_id_idx").on(table.organizationId),
    index("invitations_email_idx").on(table.email),
  ],
);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Plan = typeof plans.$inferSelect;
export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type MembershipRole = (typeof membershipRoleEnum.enumValues)[number];
export type Location = typeof locations.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type UsageCounter = typeof usageCounters.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type ConsentRecord = typeof consentRecords.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;

/** Every tenant-owned table — the set RLS must cover. */
export const TENANT_TABLES = [
  "memberships",
  "locations",
  "connections",
  "reviews",
  "subscriptions",
  "usage_counters",
  "audit_logs",
  "consent_records",
  "invitations",
] as const;
