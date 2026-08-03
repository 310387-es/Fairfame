import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
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

/**
 * The channel an İYS permission covers (P1b-T5).
 *
 * İYS records permission per channel, not per person: someone may accept
 * messages and refuse calls. Storing one blanket consent would mean either
 * over-claiming a permission the recipient never gave, or under-using one they
 * did. `email` is included because İYS covers EPOSTA too, even though our email
 * path is governed by KVKK consent today.
 */
export const consentChannelEnum = pgEnum("consent_channel", ["message", "call", "email"]);

/**
 * Where a consent came from, kept as evidence.
 *
 * İYS requires the business to be able to prove how a permission was obtained,
 * and "we have a row in our database" is not proof. The value pairs with
 * `proof_ref`, which points at the artefact — a submission id, an imported
 * file, a signed form.
 */
export const consentSourceEnum = pgEnum("consent_source", [
  "web_form",
  "in_person",
  "import",
  "message_reply",
  "iys_sync",
]);

export const sentimentEnum = pgEnum("sentiment", ["positive", "neutral", "negative"]);

/**
 * What kind of customer voice a row holds (P1b-T4).
 *
 * `docs/03` §4 models social sources as ordinary connectors whose items become
 * "normalized items tagged by `source` and `type`". A Google review and an
 * Instagram comment are both a customer saying something in public, and forcing
 * them into separate tables would mean two inboxes, two analysis paths and two
 * digests — for rows that differ only in whether a star rating exists.
 *
 * They are genuinely different in one respect, though, so the type is a column
 * rather than an inference: a `comment` has no rating and cannot be treated as
 * one, and a `dm` is **not public**, which changes what may be quoted back in a
 * digest or a social post.
 */
export const reviewItemTypeEnum = pgEnum("review_item_type", [
  "review",
  "comment",
  "mention",
  "dm",
]);

/**
 * Collection channels. `sms` and `whatsapp` are declared now but refused at
 * send time until their connectors and the İYS gate exist (P1b-T3/T5) — the
 * enum is cheap, an unenforced commercial send is not.
 */
export const campaignChannelEnum = pgEnum("campaign_channel", ["email", "sms", "whatsapp", "link"]);

export const campaignStatusEnum = pgEnum("campaign_status", ["draft", "active", "archived"]);

/** Where a campaign sends people: our hosted page, or an external platform. */
export const campaignDestinationEnum = pgEnum("campaign_destination", ["firstparty", "external"]);

/**
 * What a user wants to hear about, per location (P1a-T5).
 *
 * Three states rather than a pair of booleans: "negative only" is the setting
 * an owner of a busy location actually reaches for, and expressing it as
 * `all=false, negative=true` invites a combination — neither — that means the
 * same thing as `off` and would have to be handled anyway.
 */
/**
 * A reply's lifecycle (P1a-T6).
 *
 * `draft` → `approved` → `posted`, with `failed` for a post the platform
 * rejected. Approval is a distinct state from posting because they are
 * distinct decisions: a human signs off on the words, and a network call then
 * either lands or does not. Collapsing them would make a transport failure
 * look like a withdrawn approval.
 */
export const replyStatusEnum = pgEnum("reply_status", ["draft", "approved", "posted", "failed"]);

/**
 * A digest's lifecycle (P1a-T7).
 *
 * `pending` exists because generation calls an LLM and can fail halfway. A row
 * claimed up front is what stops two workers composing the same week twice,
 * and a `failed` row is visible evidence rather than a silently missing week.
 */
export const digestStatusEnum = pgEnum("digest_status", ["pending", "ready", "failed"]);

/**
 * What happened to a recommended action.
 *
 * `dismissed` is deliberately distinct from `done`: an owner who rejects an
 * action is telling us something different from one who completes it, and the
 * next digest closes the loop differently for each.
 */
export const digestActionStatusEnum = pgEnum("digest_action_status", ["open", "done", "dismissed"]);

export const notificationScopeEnum = pgEnum("notification_scope", ["all", "negative_only", "off"]);

/** Send now, or hold for the digest. */
export const notificationDeliveryEnum = pgEnum("notification_delivery", ["instant", "digest"]);

export const notificationTypeEnum = pgEnum("notification_type", ["new_review"]);

/** Urgency drives ordering and the email subject, not a separate channel. */
export const notificationUrgencyEnum = pgEnum("notification_urgency", ["normal", "urgent"]);

/**
 * What happened to the email for a notification.
 *
 * `deferred` is the digest case — deliberately distinct from `skipped` (the
 * user turned email off) so "why did I not get mail?" has one answer per row
 * rather than an inference.
 */
export const notificationEmailStatusEnum = pgEnum("notification_email_status", [
  "pending",
  "sent",
  "failed",
  "deferred",
  "skipped",
]);

export const reviewRequestStatusEnum = pgEnum("review_request_status", [
  "pending",
  "sent",
  "opened",
  "submitted",
  "failed",
]);

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
    /**
     * How AI replies for this location should sound (P1a-T6).
     *
     * Per location rather than per organization because a chain's flagship and
     * its airport kiosk do not talk the same way, and `docs/06` §3 puts brand
     * voice in per-location settings. Null falls back to a neutral default in
     * src/prompts.
     *
     * Owner-supplied text that reaches a prompt, so it is length-bounded and
     * placed in the *instruction* position deliberately — unlike review text,
     * which is untrusted data. The owner is allowed to steer their own replies;
     * a reviewer is not.
     */
    brandTone: text("brand_tone"),
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
    /** Last successful sync. Drives "Last synced …" in the UI. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /**
     * Earliest the scheduler may sync this connection again. The scan skips
     * anything still in the future, which is what makes backoff and rate-limit
     * deferral mean something against a scheduler that rescans every minute.
     */
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
    /** Consecutive failures; reset on success. Feeds exponential backoff. */
    failureCount: integer("failure_count").notNull().default(0),
    /** Why the last sync failed, for the connection card. */
    lastError: text("last_error"),
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
    /**
     * Review, comment, mention or DM. Defaults to `review` so every row that
     * predates social ingestion keeps its meaning.
     */
    itemType: reviewItemTypeEnum("item_type").notNull().default("review"),
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
    // A comment or a mention has no star rating to give. Letting one carry a
    // rating would put an invented number into the reputation pulse.
    check(
      "reviews_rating_only_on_reviews",
      sql`${table.itemType} = 'review' or ${table.rating} is null`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// First-party collection (P1b-T1)
// ---------------------------------------------------------------------------

/**
 * People we may contact about leaving a review.
 *
 * Deliberately the one place a customer's email or phone is stored: a review
 * submitted through our own page keeps only a `contact_id` in its payload, so
 * a KVKK erasure request is satisfied by deleting one row rather than by
 * rewriting every jsonb blob that ever mentioned the person.
 *
 * `unsubscribed_at` is the opt-out flag honoured before every send. The İYS
 * consent record that must accompany a *commercial* message is separate and
 * lands with the compliance layer (P1b-T5).
 */
export const contacts = pgTable(
  "contacts",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name"),
    email: text("email"),
    phone: text("phone"),
    locale: text("locale"),
    /** Set the moment someone opts out. Never cleared by an inbound message. */
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("contacts_organization_id_idx").on(table.organizationId),
    // Postgres treats NULLs as distinct, so these constrain only the rows that
    // actually carry the identifier — exactly the intent.
    unique("contacts_organization_id_email_key").on(table.organizationId, table.email),
    unique("contacts_organization_id_phone_key").on(table.organizationId, table.phone),
    check(
      "contacts_has_an_identifier",
      sql`${table.email} is not null or ${table.phone} is not null`,
    ),
  ],
);

/**
 * A collection strategy: which channel asks, and where it points.
 *
 * `destination` is a property of the campaign, fixed before anybody rates
 * anything. That is what makes rating-gating structurally impossible rather
 * than merely discouraged — see src/collect/routing.ts.
 */
export const campaigns = pgTable(
  "campaigns",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    channel: campaignChannelEnum("channel").notNull().default("email"),
    destination: campaignDestinationEnum("destination").notNull().default("firstparty"),
    /** Required when `destination` is external — the platform's review URL. */
    destinationUrl: text("destination_url"),
    /** Public short code. Globally unique: it is a URL, not a tenant column. */
    slug: text("slug").notNull().unique(),
    /** Language of the hosted page and the outbound message. */
    locale: text("locale"),
    status: campaignStatusEnum("status").notNull().default("draft"),
    /** Optional per-campaign copy overrides: subject, heading, body. */
    message: jsonb("message").notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index("campaigns_organization_id_idx").on(table.organizationId),
    index("campaigns_location_id_idx").on(table.locationId),
    check(
      "campaigns_external_needs_url",
      sql`${table.destination} <> 'external'::campaign_destination or ${table.destinationUrl} is not null`,
    ),
  ],
);

/**
 * One outbound ask, and its funnel: sent → opened → submitted.
 *
 * `token` is the secret in the short link. It is what proves a submission came
 * from the person we asked, so it is generated with a CSPRNG and is unique
 * across tenants (it appears in a URL before any tenant context exists).
 */
export const reviewRequests = pgTable(
  "review_requests",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    /** Null for walk-in QR/link submissions: nobody was asked. */
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    channel: campaignChannelEnum("channel").notNull(),
    status: reviewRequestStatusEnum("status").notNull().default("pending"),
    token: text("token").notNull().unique(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** First touch only — a second visit does not move the funnel backwards. */
    openedAt: timestamp("opened_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** The canonical review this ask produced, once it produces one. */
    reviewId: uuid("review_id").references(() => reviews.id, { onDelete: "set null" }),
    /**
     * The platform's id for the message we sent — a WhatsApp `wamid`, or an
     * SMS gateway reference. Delivery receipts arrive asynchronously and key on
     * it, so without this a `failed` status has nothing to attach to.
     */
    externalId: text("external_id"),
    failureReason: text("failure_reason"),
    meta: jsonb("meta").notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index("review_requests_organization_id_idx").on(table.organizationId),
    index("review_requests_campaign_id_idx").on(table.campaignId),
    index("review_requests_org_created_at_idx").on(table.organizationId, table.createdAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// AI layer (P1a-T2)
// ---------------------------------------------------------------------------

/**
 * Embedding width, and the reason it is 768 rather than the model default.
 *
 * pgvector's HNSW index tops out at 2000 dimensions, so a 3072-wide embedding
 * could be stored but never indexed — which is useless for the theme
 * clustering the Action Digest is built on. Gemini's embedding models can emit
 * 768 directly, so this is a deliberate choice rather than a truncation.
 *
 * Changing it is a migration plus a full re-embed: vectors of different widths
 * are not comparable, so there is no gradual path.
 */
export const EMBEDDING_DIMENSIONS = 768;

/**
 * One row of AI output per review.
 *
 * Separate from `reviews` on purpose. Insights are *derived* data: they can be
 * recomputed from the review at any time, they change when the prompt or model
 * changes, and they are the only part of the record that is not ground truth.
 * Keeping them in their own table means a re-analysis is a delete and reinsert
 * rather than a mutation of the canonical row.
 */
export const reviewInsights = pgTable(
  "review_insights",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    sentiment: sentimentEnum("sentiment").notNull(),
    /** -1.0 (entirely negative) to 1.0. `real` is ample for a score. */
    sentimentScore: real("sentiment_score").notNull(),
    /** Normalized theme tags, in the review's own language. */
    topics: text("topics")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** BCP-47-ish, as detected by the model rather than guessed by us. */
    language: text("language"),
    /** Null until the embedding pass runs — analysis and embedding can differ in age. */
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    /**
     * SHA-256 of the analyzed text. This is the cache key.
     *
     * `reviews.updated_at` cannot serve the purpose: the sync upsert touches it
     * on every run whether or not anything changed, so it would mark the whole
     * corpus stale after each sync. A content hash only changes when the words
     * do — which is exactly when a re-analysis is warranted (a platform review
     * really can be edited after posting).
     */
    contentHash: text("content_hash"),
    /**
     * Which prompt and model produced this. Without them, a quality regression
     * cannot be attributed to anything, and a partial re-analysis cannot tell
     * stale rows from fresh ones.
     */
    promptId: text("prompt_id").notNull(),
    model: text("model").notNull(),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [
    // One insight per review. A re-analysis replaces it rather than appending,
    // so nothing downstream has to decide which of two rows is current.
    unique("review_insights_review_id_key").on(table.reviewId),
    index("review_insights_organization_id_idx").on(table.organizationId),
    index("review_insights_org_sentiment_idx").on(table.organizationId, table.sentiment),
    // GIN over the array: "show me every review tagged 'servis'" is the Inbox
    // filter in T9 and the grouping the digest is built on.
    index("review_insights_topics_idx").using("gin", table.topics),
    check("review_insights_score_range", sql`${table.sentimentScore} between -1 and 1`),
  ],
);

/**
 * The per-organization theme vocabulary.
 *
 * `review_insights.topics` is what the model actually said; this is the
 * curated set built from it. The two are deliberately different things: the
 * raw tags are evidence and must not be rewritten, while the vocabulary is
 * editable — an owner will eventually want "servis" and "service" merged, or a
 * theme renamed for their dashboard, without falsifying what the model
 * returned about a specific review.
 */
export const tags = pgTable(
  "tags",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Normalized key used for matching against `topics`. */
    slug: text("slug").notNull(),
    /** What an owner sees. Starts equal to the slug; editable later. */
    label: text("label").notNull(),
    /** Running count, so the themes list does not aggregate on every render. */
    reviewCount: integer("review_count").notNull().default(0),
    /** Set when an owner folds this tag into another. */
    mergedIntoId: uuid("merged_into_id"),
    ...timestamps,
  },
  (table) => [
    unique("tags_organization_id_slug_key").on(table.organizationId, table.slug),
    index("tags_organization_id_idx").on(table.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// WhatsApp conversations (P1b-T3)
// ---------------------------------------------------------------------------

/**
 * When a contact last messaged us, per organization.
 *
 * Exists because WhatsApp's **24-hour customer service window** is a fact about
 * a conversation, not about a campaign. An earlier version read `opened_at` on
 * `review_requests`, which conflated two different events: opening a review
 * link we sent, and sending us a WhatsApp message. Only the second opens the
 * window, and a customer who messages us without ever receiving a campaign has
 * no `review_requests` row at all — yet replying to them is precisely the case
 * Meta permits.
 *
 * One row per (organization, contact). The window is derived from
 * `last_inbound_at`, never from anything we sent: a business cannot open its own
 * window by messaging someone, which is the entire point of the rule.
 */
export const whatsappConversations = pgTable(
  "whatsapp_conversations",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Meta's id for the customer's number, as returned on inbound events. */
    waId: text("wa_id"),
    /** The customer's most recent message. This is what opens the window. */
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    /** Ours, for diagnostics only — it never affects the window. */
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("whatsapp_conversations_org_contact_key").on(table.organizationId, table.contactId),
    index("whatsapp_conversations_org_inbound_idx").on(
      table.organizationId,
      table.lastInboundAt.desc(),
    ),
  ],
);

// ---------------------------------------------------------------------------
// Action Digest (P1a-T7)
// ---------------------------------------------------------------------------

/**
 * One weekly briefing for one location.
 *
 * The computed half — pulse, deltas, counts — lives in columns because it is
 * queried and charted; the composed half lives in `payload` because its shape
 * belongs to the digest contract in `docs/10` and will grow. Splitting on
 * "queried vs rendered" rather than on "cheap vs expensive" is what keeps the
 * Home screen to one row read.
 *
 * `unique(location_id, period_start)` is the reproducibility guarantee made
 * structural: a window has exactly one digest, so regenerating replaces rather
 * than accumulating, and "which digest was that number from" has one answer.
 */
export const digests = pgTable(
  "digests",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    /** Inclusive start of the window; exclusive end. UTC, Monday-aligned. */
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    status: digestStatusEnum("status").notNull().default("pending"),
    /** 0-100 reputation pulse for the window. Null until composed. */
    pulseScore: real("pulse_score"),
    /** Change against the previous window. Null when there is no prior digest. */
    pulseDelta: real("pulse_delta"),
    reviewCount: integer("review_count").notNull().default(0),
    /** The composed digest: themes, changes, callouts, actions, assets. */
    payload: jsonb("payload"),
    /** The locale the briefing was written in. */
    locale: text("locale"),
    promptId: text("prompt_id"),
    model: text("model"),
    lastError: text("last_error"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("digests_location_period_key").on(table.locationId, table.periodStart),
    index("digests_org_period_idx").on(table.organizationId, table.periodStart.desc()),
    index("digests_location_period_idx").on(table.locationId, table.periodStart.desc()),
    check(
      "digests_pulse_range",
      sql`${table.pulseScore} is null or ${table.pulseScore} between 0 and 100`,
    ),
    check("digests_period_order", sql`${table.periodEnd} > ${table.periodStart}`),
  ],
);

/**
 * The three actions a digest recommends, one row each.
 *
 * A separate table rather than an array inside `payload`, because these are the
 * only part of a digest that has a *life after publication*: an owner marks one
 * done, and the next week's digest has to know. State that changes belongs in
 * rows, not in a frozen JSON snapshot.
 *
 * `evidence` holds the theme and the review ids the recommendation rests on —
 * "evidence-linked" from the Definition of Done, kept as ids so the UI can link
 * to the actual reviews rather than restating them.
 */
export const digestActions = pgTable(
  "digest_actions",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    digestId: uuid("digest_id")
      .notNull()
      .references(() => digests.id, { onDelete: "cascade" }),
    /** 1, 2 or 3 — the order the digest presents them in. */
    position: integer("position").notNull(),
    text: text("text").notNull(),
    /** `{ themeSlug, reviewIds[] }` — what the recommendation rests on. */
    evidence: jsonb("evidence").notNull(),
    status: digestActionStatusEnum("status").notNull().default("open"),
    completedByUserId: uuid("completed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("digest_actions_digest_position_key").on(table.digestId, table.position),
    index("digest_actions_org_status_idx").on(table.organizationId, table.status),
    check("digest_actions_position_range", sql`${table.position} between 1 and 3`),
  ],
);

// ---------------------------------------------------------------------------
// Replies (P1a-T6)
// ---------------------------------------------------------------------------

/**
 * An owner's response to a review — drafted, edited, approved, posted.
 *
 * One row per attempt at a reply, not one per review: `unique(review_id)` would
 * be wrong the moment a post fails and someone writes a different reply, and
 * keeping the history is what makes "who approved this text" answerable. The
 * partial unique index below is the real rule — a review may have at most one
 * *live* reply (draft, approved or posted) at a time, while any number of
 * failed attempts may sit behind it.
 *
 * `ai_generated` and `edited` are separate flags on purpose. "The AI wrote
 * this" and "a human changed it" are different facts, and the interesting
 * question for both quality review and disclosure is the combination.
 */
export const replies = pgTable(
  "replies",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    /** Who last saved this text. Null for a draft nobody has touched yet. */
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Who approved it — the accountable signature, kept apart from authorship. */
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    text: text("text").notNull(),
    status: replyStatusEnum("status").notNull().default("draft"),
    aiGenerated: boolean("ai_generated").notNull().default(false),
    /** True once a human changed the generated text. */
    edited: boolean("edited").notNull().default(false),
    /** What the model first produced, kept so edits can be measured. */
    originalText: text("original_text"),
    /** Prompt revision and model, for the same reason `review_insights` keeps them. */
    promptId: text("prompt_id"),
    model: text("model"),
    /** The platform's id for the posted reply, when it gives us one. */
    externalId: text("external_id"),
    /** Why the last post attempt failed. Cleared on success. */
    lastError: text("last_error"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // At most one live reply per review. Failed attempts are excluded so a
    // rejected post does not block writing a replacement.
    uniqueIndex("replies_one_live_per_review")
      .on(table.reviewId)
      .where(sql`status <> 'failed'`),
    index("replies_organization_id_idx").on(table.organizationId),
    index("replies_org_status_idx").on(table.organizationId, table.status),
  ],
);

// ---------------------------------------------------------------------------
// Notifications (P1a-T5)
// ---------------------------------------------------------------------------

/**
 * Who wants to hear about what, and how.
 *
 * A null `location_id` is the user's default across the organization; a row
 * with a location overrides it for that location only. Storing the default as
 * a row rather than as columns on `memberships` means one resolution rule —
 * "most specific row wins" — instead of a three-way merge between a membership
 * column, a location row and a hard-coded fallback.
 *
 * `NULLS NOT DISTINCT` on the unique key is what makes that work: without it
 * Postgres treats every null `location_id` as unique and a user could
 * accumulate a dozen conflicting defaults.
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null means "this user's default for the whole organization". */
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "cascade" }),
    scope: notificationScopeEnum("scope").notNull().default("all"),
    delivery: notificationDeliveryEnum("delivery").notNull().default("instant"),
    inApp: boolean("in_app").notNull().default(true),
    email: boolean("email").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique("notification_preferences_org_user_location_key")
      .on(table.organizationId, table.userId, table.locationId)
      .nullsNotDistinct(),
    index("notification_preferences_org_user_idx").on(table.organizationId, table.userId),
  ],
);

/**
 * The in-app feed, and the record that an email was (or was not) sent.
 *
 * One row per user per event, not one row per event: the feed is per-person,
 * read state is per-person, and a shared row would need a join table to track
 * both — for no gain, since the payload is small.
 *
 * `dedupe_key` is the idempotency guard. Every path that creates notifications
 * can run twice — a retried job, an overlapping sweep — and "you have a new
 * review" arriving three times is the fastest way to teach someone to ignore
 * notifications entirely.
 *
 * The payload holds a *snapshot* (author, rating, an excerpt) rather than only
 * a review id, so the feed renders without joining and still reads correctly
 * after the review is edited — the notification describes what happened then.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "cascade" }),
    /** The review this is about. Null once the review is erased (KVKK). */
    reviewId: uuid("review_id").references(() => reviews.id, { onDelete: "set null" }),
    type: notificationTypeEnum("type").notNull(),
    urgency: notificationUrgencyEnum("urgency").notNull().default("normal"),
    /** Rendered by the UI in the reader's locale — never pre-translated copy. */
    payload: jsonb("payload").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    emailStatus: notificationEmailStatusEnum("email_status").notNull().default("pending"),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("notifications_user_dedupe_key").on(table.userId, table.dedupeKey),
    // The feed query: this user's notifications, newest first.
    index("notifications_user_created_at_idx").on(table.userId, table.createdAt.desc()),
    // The unread badge, and the "urgent first" ordering the Inbox wants.
    index("notifications_user_unread_idx")
      .on(table.userId, table.urgency, table.createdAt.desc())
      .where(sql`read_at is null`),
    index("notifications_organization_id_idx").on(table.organizationId),
    // The sender picks these up; a partial index keeps it small as the table
    // grows, since almost every row is eventually not pending.
    index("notifications_pending_email_idx")
      .on(table.organizationId, table.createdAt)
      .where(sql`email_status = 'pending'`),
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
    /**
     * Which channel this permission covers. Null for a KVKK record, which is
     * about processing rather than about a messaging channel.
     */
    channel: consentChannelEnum("channel"),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    /** Set when the person withdrew it. A row is never deleted on withdrawal. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    source: consentSourceEnum("source"),
    proofRef: text("proof_ref"),
    /**
     * When this must reach İYS.
     *
     * Turkish law gives a business **three business days** to upload a consent
     * it collected itself. Storing the deadline rather than recomputing it means
     * a holiday-calendar change cannot silently move a deadline that has already
     * been communicated, and an overdue row is one indexed query away.
     */
    iysUploadDueAt: timestamp("iys_upload_due_at", { withTimezone: true }),
    /** When it actually reached İYS. Null while outstanding. */
    iysUploadedAt: timestamp("iys_uploaded_at", { withTimezone: true }),
    /** Why the last upload attempt failed, if it did. */
    iysUploadError: text("iys_upload_error"),
    ...timestamps,
  },
  (table) => [
    index("consent_records_organization_id_idx").on(table.organizationId),
    // A person may hold a KVKK record and a per-channel İYS record at once, so
    // the channel is part of the key. `NULLS NOT DISTINCT` keeps the KVKK row
    // (channel null) unique rather than letting duplicates accumulate.
    unique("consent_records_org_contact_type_channel_key")
      .on(table.organizationId, table.contactRef, table.type, table.channel)
      .nullsNotDistinct(),
    // The upload queue: outstanding İYS consents, oldest deadline first.
    index("consent_records_iys_pending_idx")
      .on(table.iysUploadDueAt)
      .where(sql`type = 'iys' and iys_uploaded_at is null and revoked_at is null`),
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
export type ReviewInsight = typeof reviewInsights.$inferSelect;
export type NewReviewInsight = typeof reviewInsights.$inferInsert;
export type Sentiment = (typeof sentimentEnum.enumValues)[number];
export type Tag = typeof tags.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignChannel = (typeof campaignChannelEnum.enumValues)[number];
export type CampaignDestination = (typeof campaignDestinationEnum.enumValues)[number];
export type CampaignStatus = (typeof campaignStatusEnum.enumValues)[number];
export type ReviewRequest = typeof reviewRequests.$inferSelect;
export type ReviewRequestStatus = (typeof reviewRequestStatusEnum.enumValues)[number];
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
  "review_insights",
  "tags",
  "contacts",
  "campaigns",
  "review_requests",
  "subscriptions",
  "usage_counters",
  "audit_logs",
  "consent_records",
  "invitations",
] as const;
