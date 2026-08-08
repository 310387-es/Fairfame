import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
 * Where an item sits in team triage (P2-T1).
 *
 * Deliberately separate from reply state. "Answered" is a fact about the
 * platform — a reply exists and was posted — while `status` is a fact about the
 * team: an item can be `done` because someone phoned the customer, and a review
 * can carry a posted reply and still be `in_progress` because the promised
 * refund has not happened. Deriving one from the other would make both
 * unusable, and it is the second column that a workflow is actually built on.
 *
 * `ignored` is not `done`. Closing an item because it was handled and closing it
 * because it was spam are different outcomes, and only the first belongs in a
 * "resolved this week" count.
 */
export const reviewStatusEnum = pgEnum("review_status", ["open", "in_progress", "done", "ignored"]);

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
// -- Broadcasts (P4-T4) ------------------------------------------------------

export const broadcastKindEnum = pgEnum("broadcast_kind", ["review_request", "survey", "message"]);

export const broadcastStatusEnum = pgEnum("broadcast_status", [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "cancelled",
]);

/**
 * `refused` is its own state, distinct from `failed`. One means the compliance
 * gate said no before anything was attempted; the other means a platform
 * accepted the request and then could not deliver. Collapsing them would hide
 * the only one an operator can act on.
 */
export const broadcastRecipientStatusEnum = pgEnum("broadcast_recipient_status", [
  "pending",
  "sent",
  "refused",
  "failed",
]);

// -- Two-way messaging (P4-T3) ----------------------------------------------

export const messageChannelEnum = pgEnum("message_channel", ["whatsapp", "sms"]);

export const messageDirectionEnum = pgEnum("message_direction", ["inbound", "outbound"]);

/**
 * The union of both directions' lifecycles. `received` is the only inbound
 * state — there is nothing to track after a message arrives — while an outbound
 * one walks queued → sent → delivered → read, or lands on failed.
 */
export const messageStatusEnum = pgEnum("message_status", [
  "received",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
]);

// -- Surveys (P4-T2) ---------------------------------------------------------

export const surveyTypeEnum = pgEnum("survey_type", ["nps", "csat"]);

export const surveyStatusEnum = pgEnum("survey_status", ["draft", "active", "archived"]);

/** The `review_request_status` funnel, plus the state specific to a survey. */
export const surveyResponseStatusEnum = pgEnum("survey_response_status", [
  "pending",
  "sent",
  "opened",
  "answered",
  "failed",
]);

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

/**
 * How a composed digest reached someone.
 *
 * `whatsapp` is declared before it is implemented (P1b-T4/D4, gated on İYS and
 * template approval) because the alternative is a second ledger later. The
 * channel is what makes the delivery record reusable: the same digest, the same
 * recipient, two independent sends that must each be retried on their own.
 */
export const digestChannelEnum = pgEnum("digest_channel", ["email", "whatsapp"]);

/**
 * Only terminal states. A delivery that has not been attempted has no row —
 * absence is the queue, which means a crash mid-send leaves nothing to
 * reconcile and the next sweep simply tries again.
 */
export const digestDeliveryStatusEnum = pgEnum("digest_delivery_status", ["sent", "failed"]);

export const notificationScopeEnum = pgEnum("notification_scope", ["all", "negative_only", "off"]);

/** How often a scheduled PDF report goes out (P3-T5). */
export const reportCadenceEnum = pgEnum("report_cadence", ["weekly", "monthly"]);

/** Send now, or hold for the digest. */
export const notificationDeliveryEnum = pgEnum("notification_delivery", ["instant", "digest"]);

/**
 * What an alert is about.
 *
 * `sla_breach` (P2-T7) is a second kind of news, not a variation on the first.
 * "A review arrived" is about the customer; "nobody has answered this and the
 * promise has lapsed" is about the team, it fires later, and it has to be able
 * to reach someone who has already read and dismissed the arrival.
 */
export const notificationTypeEnum = pgEnum("notification_type", [
  "new_review",
  "sla_breach",
  "sla_rollup",
  /**
   * Work handed to a person (P2-T4 follow-up).
   *
   * A pair, like the SLA one above and for the same reason: one alert per item
   * while the number is small enough to act on, one rollup once bulk assignment
   * has moved fifty of them at once.
   */
  "review_assigned",
  "assignment_rollup",
]);

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
  /**
   * Which organization this person's next session opens in (W1.1).
   *
   * A session is short-lived and a preference is not, so the memory lives on
   * the user rather than being re-derived — or, as it was until now, not
   * derived at all. Read and re-checked against membership by
   * `src/auth/active-organization.ts`; nothing else may treat it as authority,
   * because a remembered organization is a *preference*, and the only thing
   * that grants access is a row in `memberships`.
   *
   * Deliberately not a BetterAuth `additionalField`: it is ours to write, and
   * declaring it there would also make it something a signup request could set.
   */
  lastActiveOrganizationId: uuid("last_active_organization_id").references(
    (): AnyPgColumn => organizations.id,
    { onDelete: "set null" },
  ),
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
  /**
   * The rest of a brand: primary colour, sender name, whether Revira's own mark
   * appears (P4-T5). The logo itself is `logo` above, BetterAuth's column.
   *
   * On the organization rather than on the agency link, because an ordinary
   * business branding its own public pages is not a white-label feature — it is
   * just having a logo. What `white_label` gates is an *agency's* brand being
   * applied to somebody else's pages.
   */
  branding: jsonb("branding").notNull().default({}),
  /**
   * The domain this organization's public pages are served from.
   *
   * **Storing it is not serving it.** DNS and a certificate are infrastructure
   * this application cannot provision, so until go-live this is what the URL
   * builders read and nothing more — see `src/agency/branding.ts`.
   */
  customDomain: text("custom_domain").unique(),
  /**
   * The payment provider this organization is billed through, and its own
   * identifier for them (W1.8).
   *
   * On the organization rather than on `subscriptions`: a business keeps one
   * customer record for as long as it exists — through cancellations, restarts
   * and plan changes — and hanging it off the subscription would mint a fresh
   * one every time somebody re-subscribed. The provider is stored beside the id
   * because an id is meaningless without it; `cus_123` is Stripe's, and the
   * same column holds an iyzico reference for a Turkish organization.
   */
  billingProvider: text("billing_provider"),
  billingCustomerId: text("billing_customer_id"),
  /**
   * True for the sample workspace, and for nothing else (W5-14).
   *
   * The demo lives in its **own organization** rather than as a flagged branch
   * inside a real one, and that is the load-bearing decision. A sample *branch*
   * would put invented reviews in the same tenant as real ones, and every facts
   * loader, every average and every export would then need to know about a flag
   * — the shape `docs/13` records as the `competitor_snapshots` mistake. A
   * separate organization is held apart by RLS, which is the strongest boundary
   * the product has, and deleting it is one cascade.
   *
   * What reads it: the banner that says where you are, the workspace switcher's
   * label, the billing prompt (suppressed — a sample workspace is not something
   * to buy), and the action that removes it. **Nothing that computes a number
   * ever reads it**, because there is no number here that could be confused
   * with a real one.
   */
  isSample: boolean("is_sample").notNull().default(false),
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
    /**
     * How this branch signs a public reply (W5-12).
     *
     * Per location for the same reason `brand_tone` is: the person answering
     * for the flagship is not the person answering for the airport kiosk, and
     * "— Ayşe, Kadıköy Şubesi" is the half of a reply that makes it read as
     * written by somebody rather than issued by a company.
     *
     * **Appended after generation, never asked of the model.** The draft system
     * prompt forbids a signature block on purpose: a generated sign-off is a
     * generated *name*, which is precisely the class of fact a reply may not
     * invent. `appendSignature` in `src/replies/style.ts` is the only writer,
     * and it is idempotent because a regenerated draft lands on text that may
     * already carry it.
     */
    replySignature: text("reply_signature"),
    /**
     * The template this branch auto-posts to a wordless five-star review (W5-6).
     *
     * **Null means off, and off is the default.** One column is the whole
     * switch: there is no separate boolean that could disagree with it.
     *
     * A *template*, not an AI draft, and that is the load-bearing part. The
     * remediation plan asks for "auto-post AI reply to 5★ with no text", and a
     * review with no text is precisely what `draftReplyForReview` refuses —
     * there is nothing to read, so a generated reply would be generated from
     * the star alone. The business writes the sentence; the rule posts it. See
     * `src/replies/auto.ts` for the rest of the reasoning and
     * `src/replies/service.ts` for the rule this deliberately does not break.
     */
    autoReplyTemplateId: uuid("auto_reply_template_id").references(() => replyTemplates.id, {
      onDelete: "set null",
    }),
    /**
     * How long to wait before posting one.
     *
     * The delay is the human's window. Twenty-four hours by default, which is
     * the plan's own figure: long enough that anybody watching the Inbox can
     * answer it themselves or turn the rule off, short enough that the reply
     * still reads as attentive.
     */
    autoReplyDelayHours: integer("auto_reply_delay_hours").notNull().default(24),
    /**
     * When this branch is open (W5-8), and therefore when its SLA clock runs.
     *
     * Seven `{ open, close }` pairs or nulls, Sunday first — the order
     * `Date.getUTCDay()` uses, so the lookup and the storage agree. Parsed
     * tolerantly by `src/locations/opening-hours.ts`; anything unrecognised
     * means "no hours", which is the old round-the-clock behaviour.
     *
     * **Null is the default and it changes nothing.** A business opts into a
     * calendar; nobody's existing deadlines are quietly reinterpreted.
     *
     * The remediation plan pairs this with the SLA calendar deliberately —
     * W4.2 refused to collect business hours precisely because nothing read
     * them, and a field nothing reads is the `competitor_snapshots` mistake.
     * This is the reader.
     */
    businessHours: jsonb("business_hours"),
    /**
     * How many hours the team gives itself to respond here (P2-T1).
     *
     * Per location and nullable, because the target is a property of how a place
     * is staffed: a flagship with a full front desk answers within four hours,
     * an airport kiosk cannot promise the same. Null falls through to the
     * organization's setting and then to `DEFAULT_SLA_HOURS` — one resolution
     * order, in src/inbox/workflow.ts, rather than a default repeated per query.
     */
    slaHours: integer("sla_hours"),
    /**
     * The address of this location's hosted public review page (P3-T3).
     *
     * Globally unique, because it is a URL: there is no tenant in scope when
     * one arrives, so the slug is how the tenant is found — the same reasoning
     * as `widgets.public_key` and `campaigns.slug`. Unlike those it is readable
     * rather than random, because this page is meant to be found and read.
     *
     * Assigned once, on first publish, and never regenerated. An indexed URL
     * that moved whenever somebody tidied up a location's name would throw away
     * whatever ranking it had earned.
     */
    publicSlug: text("public_slug").unique(),
    /**
     * Whether that page is live. Off by default, and separate from the slug so
     * that unpublishing keeps the address for whenever it goes back up.
     */
    publicPagePublished: boolean("public_page_published").notNull().default(false),
    ...timestamps,
  },
  (table) => [
    index("locations_organization_id_idx").on(table.organizationId),
    check(
      "locations_sla_hours_positive",
      sql`${table.slaHours} is null or ${table.slaHours} between 1 and 8760`,
    ),
  ],
);

/**
 * Which locations a member may see (P2-T4).
 *
 * `docs/06` §3 gives every role a location scope — a Member sees "assigned
 * locations", an agency's Client sees "their locations only" — and until now
 * there was nowhere to record that, so every member of an organization saw all
 * of it. The inbox is where it starts to matter: assigning a review to someone
 * who cannot open it is not a workflow.
 *
 * **Absence means unrestricted, except for `client`.** A membership with no rows
 * here sees every location. That is the deliberate reading: there is no screen
 * yet for assigning locations to a teammate, so the restrictive reading would
 * lock every existing member out of everything the moment this shipped, with no
 * way to let them back in. `client` is the exception, because it is the one role
 * held by someone outside the business — defaulting an agency's customer to the
 * whole organization is a leak, while defaulting them to nothing is merely an
 * empty screen. `src/auth/scope.ts` is the only place this is read.
 */
export const memberLocations = pgTable(
  "member_locations",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * The membership, not the user. A scope is a property of belonging to *this*
     * organization, and when someone is removed their scope should go with them
     * rather than linger for a future re-invitation to inherit.
     */
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [
    unique("member_locations_membership_location_key").on(table.membershipId, table.locationId),
    index("member_locations_org_membership_idx").on(table.organizationId, table.membershipId),
    index("member_locations_location_idx").on(table.locationId),
  ],
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
     * When this connection's **first** sync finished — the backfill (W1.3).
     *
     * Set once and never moved, which is what makes it usable long after the
     * fact: `last_synced_at` moves on every sync, so by the time notifications
     * are computed there is no way left to ask "was that the first one?".
     *
     * Everything a first sync brings in is history, not news. An owner who
     * connects Google on Tuesday did not have 217 things happen to them on
     * Tuesday, and a notification that says otherwise trains them to ignore the
     * bell — which is the one thing a notification cannot survive.
     * `src/notifications/service.ts` is the only reader.
     */
    firstSyncedAt: timestamp("first_synced_at", { withTimezone: true }),
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
    /**
     * *What kind* of failure it was, which `last_error` cannot say (W4.2).
     *
     * The column holds provider prose; the meaning lives in the error's type,
     * and `instanceof` is lost the moment it is written down. A health badge
     * derived by matching substrings of somebody else's message would keep
     * working right up until they reworded it, and then report "Healthy" over a
     * connection that had been dead for a month.
     *
     * A hint, never a branch: `src/connections/health.ts` treats an
     * unrecognised value exactly as it treats null.
     */
    lastErrorKind: text("last_error_kind"),
    ...timestamps,
  },
  (table) => [
    index("connections_organization_id_idx").on(table.organizationId),
    index("connections_location_id_idx").on(table.locationId),
    unique("connections_location_id_provider_key").on(table.locationId, table.provider),
  ],
);

/**
 * "We would use you if you read our Yemeksepeti reviews" — recorded (W4.2).
 *
 * The Connections screen lists sources we have **not** built, because a
 * business needs to know whether we are ever going to read theirs, and an empty
 * grid answers that with silence. Offering "Request this integration" and then
 * dropping the press would be worse than not offering it.
 *
 * `providerKey` is not a foreign key and not an enum: these keys name things
 * that are absent from `PROVIDERS` and must stay absent — a descriptor with no
 * connector behind it is a connect button that throws. See
 * `src/connectors/roadmap.ts`.
 */
export const integrationRequests = pgTable(
  "integration_requests",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    /**
     * Kept when they leave. The demand signal outlives the employee, and
     * cascading the delete would quietly deflate the only count this is for.
     */
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    // A signal, not a petition: pressing it forty times must not make the
    // number useless for deciding what to build next.
    unique("integration_requests_org_provider_key").on(table.organizationId, table.providerKey),
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

    // -- Team workflow (P2-T1) ------------------------------------------------
    //
    // These live on `reviews` rather than in a side table because there is
    // exactly one triage state per item and every inbox query filters or sorts
    // on it. A join table would buy nothing and would turn the list query — the
    // most-run query in the product — into an outer join whose null case means
    // the same thing as `open` anyway.

    /** Where this sits in triage. Every row has one; backfilled to `open`. */
    status: reviewStatusEnum("status").notNull().default("open"),
    /**
     * Who owns it. References `users`, not `memberships`: a membership can be
     * deleted and recreated when someone's role changes, which would orphan
     * every assignment they held. Whether the assignee is still a member of the
     * organization — and still scoped to this location — is checked at
     * assignment time by the service layer, since it is a rule about *now*.
     */
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * Triage severity, 0–100. Derived, never entered by hand — see
     * src/inbox/workflow.ts for the formula and for why recency is *not* in it:
     * a score that decays with age is wrong an hour after it is written, so age
     * enters the sort (`priority desc, posted_at desc`) instead of the column.
     *
     * Nullable because a row that predates analysis and ingest-time derivation
     * has no honest value, and 0 would read as "nothing to see here".
     */
    priority: integer("priority"),
    /**
     * When the team first answered — set once, on the first reply, and never
     * moved. This is the numerator of every response-time figure, so a later
     * follow-up reply must not overwrite it.
     */
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    /**
     * When the business answered **on the platform itself** (W1.2).
     *
     * Source data, not workflow: it records something the provider told us, the
     * way `posted_at` does. Most owners were replying in Google Business
     * Profile long before they had us, and until this column existed those
     * replies were invisible to every count on every screen — the review read
     * as unanswered, went overdue, and sat at the top of the triage queue.
     *
     * Normalised at ingest by each connector from its own payload shape,
     * because only the connector knows it: Google writes `reviewReply`, the
     * mock writes `ownerReply`, and the read-time sniff this replaces knew
     * about exactly one of them.
     *
     * Deliberately **not** merged into `first_response_at`, which means "when
     * the team answered through the product" and is the numerator of every
     * response-time figure. Writing a platform timestamp into it would put a
     * number we did not measure into a metric we report.
     *
     * Unlike the workflow columns, a re-sync *does* update this one — learning
     * that the owner has since answered on Google is the entire point.
     * `src/inbox/answered.ts` is the only interpreter.
     */
    ownerRepliedAt: timestamp("owner_replied_at", { withTimezone: true }),
    /**
     * When the team was told this deadline had lapsed (P2-T7).
     *
     * A stamp on the review rather than an inferred "does a notification row
     * exist", because a *rollup* alert reports twenty reviews in one row and
     * would otherwise leave nineteen of them looking un-reported — so the next
     * sweep would report them again, and the one after that. Claiming rows by
     * stamping them is also what makes two workers sweeping at once safe.
     */
    slaAlertedAt: timestamp("sla_alerted_at", { withTimezone: true }),
    /**
     * When a response is due, fixed at ingest from the location's SLA target.
     *
     * Stored rather than recomputed for the same reason as
     * `consent_records.iys_upload_due_at`: an owner who raises the target from
     * 4 hours to 24 must not silently un-breach every item that is already
     * late. The deadline an item was admitted under is the deadline it keeps.
     */
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }),

    // -- Public display (P3-T0) ----------------------------------------------

    /**
     * When the business cleared this review for its own website, and who did.
     *
     * The gate on every public surface — widgets, the rating badge, the SEO
     * page. Null means not approved, and that is where every row starts: a
     * backfill to "approved" would record a decision nobody made, on the one
     * flag whose whole job is to record that somebody made it.
     *
     * A timestamp rather than a boolean because the question asked later is
     * always "when, and by whom" — a boolean answers neither, and a published
     * quote that nobody can account for is the problem this column exists to
     * prevent.
     *
     * Note this is *not* rating-gating: it decides what a business puts in its
     * own marketing, long after the review is written and published wherever it
     * came from. Rating-gating is steering *who gets asked* and *where they are
     * sent* based on how they feel — that happens in src/collect/routing.ts,
     * before any rating exists, and remains structurally impossible.
     */
    /**
     * The earlier review this one duplicates, across sources (W5-7).
     *
     * Null for almost everything. Set by `src/reviews/duplicates.ts` when the
     * same customer said the same thing on two platforms within a few days —
     * which happens because a business links its own form from the same page it
     * links its Google listing.
     *
     * **Nothing that computes a number reads this.** The average, the count and
     * the digest all still see both rows, deliberately: a review that exists on
     * Google is counted by everybody looking at Google, and a private average
     * that disagreed with the public one would be the wrong kind of clever. It
     * drives a badge and a filter, so nobody answers the same person twice.
     *
     * ON DELETE SET NULL: erasing the original leaves the other review standing
     * on its own rather than pointing at nothing.
     */
    duplicateOfId: uuid("duplicate_of_id"),
    displayApprovedAt: timestamp("display_approved_at", { withTimezone: true }),
    displayApprovedByUserId: uuid("display_approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

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
    // Triage listing: one status within a location, newest first. The Phase 1
    // index above stays — an unfiltered inbox does not touch status.
    index("reviews_org_location_status_idx").on(
      table.organizationId,
      table.locationId,
      table.status,
      table.postedAt.desc(),
    ),
    // "Sort by priority" — the default order of a triage queue.
    index("reviews_org_location_priority_idx").on(
      table.organizationId,
      table.locationId,
      table.priority.desc().nullsLast(),
      table.postedAt.desc(),
    ),
    // "Assigned to me". Partial: most rows are unassigned, and the query never
    // asks for those.
    index("reviews_org_assignee_idx")
      .on(table.organizationId, table.assigneeUserId, table.postedAt.desc())
      .where(sql`assignee_user_id is not null`),
    // "Overdue". Only unresolved items can breach, so the closed ones — which
    // become the bulk of the table — are left out of the index entirely.
    index("reviews_org_sla_due_idx")
      .on(table.organizationId, table.slaDueAt)
      .where(sql`sla_due_at is not null and status in ('open', 'in_progress')`),
    check("reviews_rating_range", sql`${table.rating} is null or ${table.rating} between 1 and 5`),
    check(
      "reviews_priority_range",
      sql`${table.priority} is null or ${table.priority} between 0 and 100`,
    ),
    // A comment or a mention has no star rating to give. Letting one carry a
    // rating would put an invented number into the reputation pulse.
    check(
      "reviews_rating_only_on_reviews",
      sql`${table.itemType} = 'review' or ${table.rating} is null`,
    ),
    // The public widget read. Partial: approved rows are the small minority,
    // and the public query never asks for the others.
    index("reviews_org_display_approved_idx")
      .on(table.organizationId, table.locationId, table.postedAt.desc())
      .where(sql`display_approved_at is not null`),
    /**
     * A direct message can never be published — settled in the database, not in
     * whichever query happens to be reading.
     *
     * A DM is private correspondence between one person and the business. It
     * was never public anywhere, it carries no `url` for that same reason, and
     * whoever sent it had no way to know it might end up on a marketing page.
     * Every other item type is already public where it came from, or was
     * submitted to a form that says where it goes.
     */
    check(
      "reviews_dm_never_published",
      sql`${table.itemType} <> 'dm' or ${table.displayApprovedAt} is null`,
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

// ---------------------------------------------------------------------------
// Light CRM (P4-T1)
// ---------------------------------------------------------------------------

/**
 * A label a business puts on a person.
 *
 * **One table, where reviews needed two.** `review_tags` points at `tags`, a
 * curated vocabulary row, and the indirection earns its keep there: `tags`
 * carries a running `review_count` so the themes list need not aggregate on
 * every render, and `merged_into_id` so two themes can be folded together.
 * Contact labels have neither, so a vocabulary table here would exist only to
 * hold a string this table already holds.
 *
 * What the vocabulary bought is kept without the table. `slug` is the
 * normalised form — src/contacts/tags.ts reuses the Turkish-aware slugifier
 * from src/seo/slug.ts — and it, not `label`, is what uniqueness and every
 * filter key on, so "VIP" and "vip " are one segment rather than two. `label`
 * is what somebody typed and is shown as typed; applying a slug the
 * organization already uses adopts the existing label, which is what keeps a
 * rename to a single UPDATE.
 */
export const contactTags = pgTable(
  "contact_tags",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Normalised. What filters and segments match on. */
    slug: text("slug").notNull(),
    /** As typed, and shown as typed. */
    label: text("label").notNull(),
    /** Null once they leave — the label outlives the person. */
    taggedByUserId: uuid("tagged_by_user_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [
    unique("contact_tags_contact_slug_key").on(table.contactId, table.slug),
    index("contact_tags_org_slug_idx").on(table.organizationId, table.slug),
    index("contact_tags_contact_idx").on(table.contactId),
    check("contact_tags_slug_not_blank", sql`length(${table.slug}) > 0`),
  ],
);

/**
 * A named contact filter — an audience.
 *
 * Stores the **query string**, flat, exactly as `saved_views` does, so the
 * tolerant parser that reads the URL is also the validator for what was stored
 * and a filter dropped in a later release degrades to "ignore that key".
 *
 * **No owner column, and that is the one real departure from `saved_views`.** A
 * saved view is a way of looking at a queue, so a private one is coherent. A
 * segment is an audience: P4-T4 points campaigns at these, and a campaign that
 * sends real messages to one person's private list is not something an
 * organization can account for afterwards. So a segment belongs to the
 * organization, creating one needs admin, and a personal audience has no shape
 * in which it can exist.
 */
export const contactSegments = pgTable(
  "contact_segments",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Query-string pairs. Validated on read by src/contacts/filters.ts. */
    filters: jsonb("filters").notNull().default({}),
    /** Display order in the chip row. Ties break on name. */
    position: integer("position").notNull().default(0),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    unique("contact_segments_org_name_key").on(table.organizationId, table.name),
    index("contact_segments_org_position_idx").on(table.organizationId, table.position),
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
// Surveys (P4-T2)
// ---------------------------------------------------------------------------

/**
 * An NPS or CSAT survey.
 *
 * Shaped like `campaigns` on purpose: a definition that fixes everything
 * *before* anybody answers.
 *
 * **The no-review-gating rule lives in the shape rather than in a check.** A
 * survey has no review destination of its own — it names a collection
 * *campaign*, and where that points is decided by `src/collect/routing.ts`,
 * which takes a campaign and nothing else and has never been able to see a
 * rating. So a survey inherits the guarantee instead of re-deriving it, and
 * making the invitation depend on the score would mean giving that function a
 * parameter three unrelated call sites depend on it not having.
 */
export const surveys = pgTable(
  "surveys",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * NPS (0–10) or CSAT (1–5). The scale is *not* stored: one that disagreed
     * with the type would make every historical score unreadable, and
     * `src/surveys/scoring.ts` is the single owner of what each type means.
     */
    type: surveyTypeEnum("type").notNull(),
    status: surveyStatusEnum("status").notNull().default("draft"),
    /** Language of the hosted page and the invitation. */
    locale: text("locale"),
    /** Public short code. Globally unique: it is a URL, not a tenant column. */
    slug: text("slug").notNull().unique(),
    /** The question, if the business wrote its own. Null uses the template. */
    question: text("question"),
    /**
     * Whether a detractor is offered a private "tell us more" box after
     * answering. **The only thing a score is allowed to decide.**
     */
    followUpEnabled: boolean("follow_up_enabled").notNull().default(true),
    followUpPrompt: text("follow_up_prompt"),
    /**
     * Where a public review is invited after answering — for everybody, at
     * every score, or for nobody. Null means the survey never mentions reviews.
     */
    reviewCampaignId: uuid("review_campaign_id").references(() => campaigns.id, {
      onDelete: "set null",
    }),
    /** Per-survey copy overrides for the invitation: subject, heading, body. */
    message: jsonb("message").notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index("surveys_organization_id_idx").on(table.organizationId),
    index("surveys_location_id_idx").on(table.locationId),
  ],
);

/**
 * One person's participation in one survey, from ask to answer.
 *
 * One table rather than "sends" plus "answers", for the reason `review_requests`
 * is one table: "we asked 200 and 40 answered" is the first question anybody
 * has, and across two tables it needs a join plus a decision about which side is
 * authoritative. A walk-in answer — a QR scan with no invitation behind it — is
 * a row created at answer time with `sent_at` null, exactly as
 * `recordWalkInRequest` does for reviews.
 */
export const surveyResponses = pgTable(
  "survey_responses",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    surveyId: uuid("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    /** Null for a walk-in: nobody was asked, and nobody gave us an address. */
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    channel: campaignChannelEnum("channel").notNull(),
    status: surveyResponseStatusEnum("status").notNull().default("pending"),
    /** The secret in the link, CSPRNG-generated and unique across tenants. */
    token: text("token").notNull().unique(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** First touch only — a second visit does not move the funnel backwards. */
    openedAt: timestamp("opened_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /**
     * The raw answer, on the type's own scale. Stored raw rather than
     * normalised: a 7 means different things on the two scales, and converting
     * at write time would destroy the only number the customer actually gave.
     */
    score: integer("score"),
    /** What they wrote alongside the score — what the survey asked for. */
    comment: text("comment"),
    /**
     * The **private** follow-up a detractor is offered after answering.
     *
     * Kept apart from `comment` because it was given under a different promise:
     * it answers "what went wrong, and may we put it right", not "what do you
     * think of us". It is never a candidate for public display anywhere.
     */
    followUpComment: text("follow_up_comment"),
    externalId: text("external_id"),
    failureReason: text("failure_reason"),
    meta: jsonb("meta").notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index("survey_responses_organization_id_idx").on(table.organizationId),
    index("survey_responses_survey_answered_idx").on(table.surveyId, table.answeredAt.desc()),
    index("survey_responses_org_answered_idx")
      .on(table.organizationId, table.answeredAt.desc())
      .where(sql`answered_at is not null`),
    index("survey_responses_contact_idx").on(table.contactId),
    check(
      "survey_responses_score_range",
      sql`${table.score} is null or ${table.score} between 0 and 10`,
    ),
    // A row claiming to be answered must carry an answer, and vice versa —
    // otherwise an interrupted write leaves an "answered" row with no score,
    // silently dragging every average down by counting a non-answer.
    check(
      "survey_responses_answered_has_score",
      sql`(${table.answeredAt} is null) = (${table.score} is null)`,
    ),
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
    /**
     * Canonical themes from `src/reviews/taxonomy.ts` (W3.2).
     *
     * The closed vocabulary — what is charted, filtered, compared and
     * translated. `topics` above stays as the free-text long tail in the
     * customer's own words; the two are not alternatives.
     *
     * Nullable, and null means "analysed before there was a taxonomy" rather
     * than "no themes". A screen must be able to tell those apart, because a
     * false negative here is one a manager would act on.
     */
    themes: text("themes").array(),
    /**
     * People the customer named, as they wrote them (P3-T4).
     *
     * Personal data about employees — see migration 0033 for what follows from
     * that. Empty for anything analysed before `analyze_review@2`, which is not
     * the same as "nobody was mentioned"; the Insights page distinguishes the
     * two rather than reporting an un-analysed corpus as a quiet one.
     */
    staff: text("staff")
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

/**
 * Tags a person put on a review by hand (P2-T6).
 *
 * A separate table rather than another entry in `review_insights.topics`,
 * because those two are different kinds of claim. `topics` is *what the model
 * said* — evidence, and rewriting it would falsify the record a re-analysis is
 * measured against. This is what a colleague decided, and it survives every
 * re-analysis precisely because the model has no say in it.
 *
 * Points at `tags`, the organization's curated vocabulary, rather than storing
 * free text: tagging fifty reviews "servis" and fifty more "Servis " should not
 * produce two themes, and a rename in the vocabulary has to reach every review
 * already carrying it.
 */
export const reviewTags = pgTable(
  "review_tags",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    /** Who applied it. Null once they leave — the tag outlives the person. */
    taggedByUserId: uuid("tagged_by_user_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [
    unique("review_tags_review_tag_key").on(table.reviewId, table.tagId),
    index("review_tags_org_tag_idx").on(table.organizationId, table.tagId),
    index("review_tags_review_idx").on(table.reviewId),
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

/**
 * One outbound send, of one thing, to one audience, now or later (P4-T4).
 *
 * **Named `broadcasts`, not `campaigns`, and that is a deliberate deviation
 * from `docs/20`'s wording.** The product has used "campaign" since P1b-T1 for
 * a *collection strategy* — a location, a destination, a hosted page and a QR
 * code, labelled "Campaign name" on `/get-reviews`. Two different things one
 * screen apart, both called a campaign, is worse than a table whose name does
 * not match a sentence in a build plan. A broadcast *references* a campaign for
 * its review-request kind; it does not replace it.
 */
export const broadcasts = pgTable(
  "broadcasts",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: broadcastKindEnum("kind").notNull(),
    channel: campaignChannelEnum("channel").notNull(),
    /** `set null`: deleting a segment must not delete what was sent to it. */
    segmentId: uuid("segment_id").references(() => contactSegments.id, { onDelete: "set null" }),
    /**
     * **The audience as it was, not as it is.**
     *
     * A segment is a live query, so re-resolving it a month later answers a
     * different question. The filter is copied here when the broadcast is
     * queued; `broadcast_recipients` holds the list it resolved to, which is
     * the answer that actually matters.
     */
    audience: jsonb("audience").notNull().default({}),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    surveyId: uuid("survey_id").references(() => surveys.id, { onDelete: "set null" }),
    templateName: text("template_name"),
    templateValues: jsonb("template_values").notNull().default([]),
    /** Null means "send when told". A past time is sent by the next sweep. */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    status: broadcastStatusEnum("status").notNull().default("draft"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** The whole send failing — e.g. the plan's credit is spent. */
    failureReason: text("failure_reason"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    index("broadcasts_organization_id_idx").on(table.organizationId, table.createdAt.desc()),
    // The due queue. Partial, because almost every row is draft or sent
    // forever and the sweep only ever asks about the handful that are waiting.
    index("broadcasts_due_idx")
      .on(table.scheduledAt)
      .where(sql`status = 'scheduled'`),
    check(
      "broadcasts_review_request_needs_campaign",
      sql`${table.kind} <> 'review_request' or ${table.campaignId} is not null`,
    ),
    check(
      "broadcasts_survey_needs_survey",
      sql`${table.kind} <> 'survey' or ${table.surveyId} is not null`,
    ),
    check(
      "broadcasts_message_needs_template",
      sql`${table.kind} <> 'message' or ${table.templateName} is not null`,
    ),
  ],
);

/**
 * Who a broadcast went to, and what happened (P4-T4).
 *
 * **The audience snapshot.** A segment is a live query; this is the list it
 * resolved to at send time, which is the only version of "who did this go to"
 * that stays true when somebody edits the segment afterwards.
 *
 * Delivery and conversion are **pointers, not copies**. `review_requests`,
 * `survey_responses` and `messages` already track their own funnels, and
 * duplicating any of that here would create two numbers able to disagree. This
 * table says which row a recipient produced; the funnel says what became of it.
 */
export const broadcastRecipients = pgTable(
  "broadcast_recipients",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    broadcastId: uuid("broadcast_id")
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    status: broadcastRecipientStatusEnum("status").notNull().default("pending"),
    /** The gate's own reason, verbatim. Stored rather than summarised. */
    refusalReason: text("refusal_reason"),
    reviewRequestId: uuid("review_request_id").references(() => reviewRequests.id, {
      onDelete: "set null",
    }),
    surveyResponseId: uuid("survey_response_id").references(() => surveyResponses.id, {
      onDelete: "set null",
    }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [
    // One person, one place in a send. Also what makes a re-run idempotent.
    unique("broadcast_recipients_broadcast_contact_key").on(table.broadcastId, table.contactId),
    index("broadcast_recipients_broadcast_idx").on(table.broadcastId, table.status),
    index("broadcast_recipients_contact_idx").on(table.contactId),
  ],
);

/**
 * Which client organizations an agency looks after (P4-T5).
 *
 * **The link grants nothing.** Access is `memberships`, exactly as it has been
 * since Phase 0; this records a relationship, and the console lists a client
 * only when both hold. The moment a relationship table could widen
 * `app.current_org()` the product would have two answers to "may this person
 * read this row", and RLS would no longer be the one that matters.
 *
 * `organization_id` is the **agency**, so the standard tenant policy applies
 * unchanged: the row belongs to the agency and the agency alone may see it.
 */
export const agencyClients = pgTable(
  "agency_clients",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientOrganizationId: uuid("client_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** What the agency calls them internally. Null shows their own name. */
    label: text("label"),
    ...timestamps,
  },
  (table) => [
    unique("agency_clients_pair_key").on(table.organizationId, table.clientOrganizationId),
    index("agency_clients_organization_id_idx").on(table.organizationId),
    index("agency_clients_client_idx").on(table.clientOrganizationId),
    // An agency is not its own client: the console would list itself inside
    // itself and the branding resolver would recurse.
    check("agency_clients_not_self", sql`${table.organizationId} <> ${table.clientOrganizationId}`),
  ],
);

/**
 * One message, in either direction (P4-T3).
 *
 * **The table `src/contacts/timeline.ts` has been apologising for since T1.**
 * Until this existed the only record of a conversation was
 * `whatsapp_conversations`, which holds two timestamps because that is all
 * Meta's 24-hour window needs — so the timeline rendered at most two message
 * events and they *moved* rather than accumulated.
 *
 * `whatsapp_conversations` is not replaced. It records a **WhatsApp rule** that
 * SMS does not have and that the compliance gate reads on every send; folding
 * it in here would make the gate derive a legal fact by scanning rows.
 *
 * **There is deliberately no `conversations` table.** A conversation is the
 * messages with one contact, in order. An entity holding a participant list
 * would duplicate `contacts` and be able to disagree with it; the inbox is a
 * `DISTINCT ON (contact_id)` over this.
 */
/**
 * A messaging channel an organization has connected (W2.2).
 *
 * Deliberately **not** a `connections` row. That table is the review-source
 * table — every row has a `locationId` because a source is polled per branch —
 * and a WhatsApp Business Account is one account for the whole business. See
 * migration 0046 for the full argument.
 *
 * There is no row for SMS and there should not be: SMS is provisioned by the
 * *deployment* (`SMS_GATEWAY`), not by a business, so a row here would imply a
 * connect flow that does not exist. `src/channels/registry.ts` is where that
 * distinction is written down.
 */
export const channelConnections = pgTable(
  "channel_connections",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channel: messageChannelEnum("channel").notNull(),
    status: connectionStatusEnum("status").notNull().default("pending"),
    /** The provider's own id — a WhatsApp phone number id. Non-secret. */
    externalId: text("external_id"),
    /** What the business calls it, for the status card. */
    displayName: text("display_name"),
    config: jsonb("config").notNull().default({}),
    /** Encrypted at the application layer — never plaintext. */
    encryptedTokens: text("encrypted_tokens"),
    /** Why the last attempt failed, so a card can say more than "error". */
    lastError: text("last_error"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("channel_connections_org_channel_key").on(table.organizationId, table.channel),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Not nullable. A message from a number we hold no contact for is **not
     * stored** — see `resolveContact` in messaging/whatsapp-inbound.ts —
     * because recording it would create a person nobody consented to give us.
     */
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    channel: messageChannelEnum("channel").notNull(),
    direction: messageDirectionEnum("direction").notNull(),
    status: messageStatusEnum("status").notNull(),
    body: text("body"),
    /** The approved template this was sent as, if it was one. */
    templateName: text("template_name"),
    /** A WhatsApp `wamid`, an SMS gateway reference. Receipts key on it. */
    externalId: text("external_id"),
    /** Who pressed send. Null for inbound and for anything sent automatically. */
    sentByUserId: uuid("sent_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * **The compliance record, and the reason it is stored rather than derived.**
     *
     * Every outbound message left under exactly one basis: `commercial`,
     * resting on a registered İYS permission, or `service`, a reply inside the
     * 24-hour window the customer opened. That is the question a regulator
     * asks, and recomputing it a year later would answer with today's window
     * state rather than the one that applied. Null for inbound.
     */
    intent: text("intent"),
    failureReason: text("failure_reason"),
    meta: jsonb("meta").notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index("messages_org_contact_created_idx").on(
      table.organizationId,
      table.contactId,
      table.createdAt.desc(),
    ),
    index("messages_org_created_idx").on(table.organizationId, table.createdAt.desc()),
    /**
     * Webhook dedup. **Meta may deliver the same webhook more than once** — they
     * say so — and without this a redelivery puts the customer's message in the
     * thread twice, which is indistinguishable from them repeating themself.
     */
    uniqueIndex("messages_org_channel_external_key")
      .on(table.organizationId, table.channel, table.externalId)
      .where(sql`external_id is not null`),
    check(
      "messages_intent_matches_direction",
      sql`${table.direction} = 'outbound' or ${table.intent} is null`,
    ),
    check(
      "messages_status_matches_direction",
      sql`(${table.direction} = 'inbound') = (${table.status} = 'received')`,
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
    /**
     * Which lever this action pulls — one of `DIGEST_LEVERS` (W1.6).
     *
     * Text rather than an enum, because the list is a *prompt* constraint and
     * will move as the product learns what owners actually act on; a database
     * enum would make each revision a migration and a deploy. Nullable so every
     * digest written before this column keeps its meaning rather than being
     * backfilled with a guess about what somebody meant.
     *
     * Stored rather than derived because it is what the model committed to at
     * the time, and W2.1's completion tracking asks "which kinds of action does
     * this business actually finish" — a question the text alone cannot answer.
     */
    lever: text("lever"),
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

/**
 * A competitor a business has named (P3-T6).
 *
 * Real configuration — the business typed it — which is why it is stored, while
 * the *numbers* about that competitor are not. See migration 0035: the only
 * source that can produce them today is a fixture, and invented rows written
 * into a customer's database outlive the flag that produced them.
 */
export const competitors = pgTable(
  "competitors",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null benchmarks the organization as a whole. */
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Free-form like `reviews.source`: the set grows with each connector. */
    provider: text("provider").notNull().default("google"),
    /** A place id, a handle, a URL. Opaque here; only the adapter parses it. */
    externalRef: text("external_ref").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index("competitors_organization_id_idx").on(table.organizationId),
    unique("competitors_org_provider_ref_key").on(
      table.organizationId,
      table.locationId,
      table.provider,
      table.externalRef,
    ),
  ],
);

/**
 * A standing request for a PDF report (P3-T5).
 *
 * Belongs to a **person**, not to an organization, like a notification
 * preference: "email me this every Monday" is a personal arrangement, and a
 * shared one would need recipient management the product cannot offer until
 * invitations exist. `locationId` null means every branch that person may see,
 * resolved at send time rather than frozen here — scope can change, and a
 * report that kept mailing a branch somebody lost access to would be a leak.
 */
export const reportSchedules = pgTable(
  "report_schedules",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null spans every location the recipient is scoped to. */
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "cascade" }),
    cadence: reportCadenceEnum("cadence").notNull().default("weekly"),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index("report_schedules_organization_id_idx").on(table.organizationId),
    unique("report_schedules_org_user_location_key").on(
      table.organizationId,
      table.userId,
      table.locationId,
    ),
  ],
);

/**
 * What was actually sent, keyed by the period it covered (P3-T5).
 *
 * The same ledger shape as `digest_deliveries` and for the same reason: the
 * sweep runs often and is allowed to re-run, so "already sent" has to be a row
 * rather than an assumption about how often a job fired. Keying on the period
 * rather than a timestamp is what makes a late run still correct — a sweep
 * that first fires on Wednesday sends Monday's report exactly once.
 */
export const reportDeliveries = pgTable(
  "report_deliveries",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => reportSchedules.id, { onDelete: "cascade" }),
    /** The window's start, UTC, normalised to the cadence's boundary. */
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    status: digestDeliveryStatusEnum("status").notNull(),
    /** The transport's reason, kept for the failed rows a human has to explain. */
    error: text("error"),
    /** Null on a failed row: nothing left. */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("report_deliveries_organization_id_idx").on(table.organizationId),
    unique("report_deliveries_schedule_period_key").on(table.scheduleId, table.periodStart),
  ],
);

/**
 * One record per (digest, recipient, channel) — who has already been sent what.
 *
 * The digest sweep runs hourly and is deliberately allowed to re-run, so
 * "have we already mailed this?" has to be a fact in the database rather than a
 * property of how often the job fires. Without it, every sweep for a week whose
 * digest is ready would mail the same briefing again.
 *
 * Per *recipient* rather than a timestamp on `digests`, because a send is not
 * one event: a location with five subscribers can have three delivered and two
 * bounced, and a single `emailed_at` column can only record "yes" or "no" for
 * the whole set. The retry then either re-mails the three who already read it
 * or abandons the two who never got it. Rows make partial failure expressible,
 * which is the only state that actually needs handling.
 *
 * `unique(digest_id, user_id, channel)` is what makes the send idempotent, and
 * a failed row is updated in place rather than accumulating one row per
 * attempt: the interesting question is "did this person get it", not "how many
 * times did we try".
 */
export const digestDeliveries = pgTable(
  "digest_deliveries",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    digestId: uuid("digest_id")
      .notNull()
      .references(() => digests.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: digestChannelEnum("channel").notNull(),
    status: digestDeliveryStatusEnum("status").notNull(),
    /** The transport's reason, kept for the failed rows a human has to explain. */
    error: text("error"),
    /** Null on a failed row: nothing left. */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("digest_deliveries_digest_user_channel_key").on(
      table.digestId,
      table.userId,
      table.channel,
    ),
    // The sender's own lookup: what has already gone out for this digest.
    index("digest_deliveries_digest_idx").on(table.digestId, table.channel),
    index("digest_deliveries_org_created_idx").on(table.organizationId, table.createdAt.desc()),
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
// Team workflow (P2-T1)
// ---------------------------------------------------------------------------

/**
 * Canned replies a team writes once and reuses.
 *
 * Separate from `replies` because they are different kinds of object: a reply is
 * a fact about one review, a template is a piece of the organization's voice
 * that has no review attached. The body carries `{{placeholders}}` that are
 * substituted at insert time (P2-T5), so it is never posted as written.
 *
 * `language` is the locale the body is written in, not a translation key: a
 * Turkish template and its English sibling are two rows, because a good reply in
 * one language is rarely a translation of the other. The picker offers the ones
 * matching the review's language first.
 */
export const replyTemplates = pgTable(
  "reply_templates",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    body: text("body").notNull(),
    /** A supported locale (`src/i18n`). Plain text, like every other locale column. */
    language: text("language").notNull(),
    /** Free-form labels — "negative", "no-show", "teşekkür". Filters the picker. */
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (table) => [
    index("reply_templates_organization_id_idx").on(table.organizationId),
    // Same name in two languages is the normal case; the same name twice in one
    // language is a mistake nobody would spot in a dropdown.
    unique("reply_templates_org_language_name_key").on(
      table.organizationId,
      table.language,
      table.name,
    ),
    index("reply_templates_tags_idx").using("gin", table.tags),
  ],
);

/**
 * A named filter combination — "my overdue negatives", "everything from Google".
 *
 * `filters` is jsonb rather than columns because it stores the *inbox filter
 * state*, which is the one shape in this schema guaranteed to keep growing: a
 * new filter in P2-T3 must not mean a migration plus a backfill of every saved
 * view. It is validated with Zod on read, so a view saved against a filter that
 * later disappears degrades to "ignore that key" instead of breaking the screen.
 *
 * `owner_user_id` null means shared with the whole organization. A nullable
 * owner rather than an `is_shared` flag, because the two would be able to
 * disagree — a shared view that still names a private owner has no meaning.
 */
export const savedViews = pgTable(
  "saved_views",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null = shared with the organization. Otherwise private to this user. */
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The inbox filter state. Validated by Zod on read — see src/inbox/views.ts. */
    filters: jsonb("filters").notNull().default({}),
    /** Display order within the owner's list. Ties break on name. */
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    // `NULLS NOT DISTINCT` so the shared views (owner null) are held to the same
    // one-name-one-view rule as a person's own.
    unique("saved_views_org_owner_name_key")
      .on(table.organizationId, table.ownerUserId, table.name)
      .nullsNotDistinct(),
    index("saved_views_org_owner_idx").on(table.organizationId, table.ownerUserId, table.position),
  ],
);

// ---------------------------------------------------------------------------
// Public showcase (P3-T0)
// ---------------------------------------------------------------------------

/**
 * An embeddable display of an organization's approved reviews.
 *
 * Shape from `docs/03` §Data model (id, org_id, public_key, filters, style),
 * plus the `published` flag `docs/19` asks for.
 *
 * This is the one tenant table whose primary lookup happens with no tenant in
 * scope: a stranger's browser arrives holding only `public_key`, and that key
 * is how the organization is discovered. `src/widgets/public.ts` is the only
 * place that lookup lives — everything after it runs under RLS like anything
 * else, and no caller ever supplies an organization id.
 */
export const widgets = pgTable(
  "widgets",
  {
    id: primaryId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Null means every location in the organization. A chain that wants one
     * widget per branch makes one per branch; a single-site business should not
     * have to name its only location to get a widget.
     */
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * The lookup key, and the only thing the public endpoint is handed.
     *
     * Globally unique because there is no tenant in scope when it is read. Not
     * a secret — it sits in the customer's page source — but CSPRNG-generated
     * and long, so the namespace cannot be walked: guessing keys must not be a
     * way to enumerate other businesses. See `src/widgets/keys.ts`.
     */
    publicKey: text("public_key").notNull(),
    /** Which reviews qualify. Validated by Zod both ways — src/widgets/config.ts. */
    filters: jsonb("filters").notNull().default({}),
    /** How it looks: layout, theme, locale, accent. Same validation. */
    style: jsonb("style").notNull().default({}),
    /**
     * Off by default. Creating a widget in the builder must not be the same
     * action as putting it on the internet.
     */
    published: boolean("published").notNull().default(false),
    ...timestamps,
  },
  (table) => [
    unique("widgets_public_key_key").on(table.publicKey),
    index("widgets_organization_id_idx").on(table.organizationId),
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
    /**
     * The nightly window in which email waits (W5-15).
     *
     * Minutes since local midnight, both nullable, and either one missing means
     * no quiet hours. A window may wrap midnight — 22:00–08:00 is what somebody
     * means by "at night", and `from < to` would refuse the only shape anybody
     * wants. `src/notifications/quiet-hours.ts` is the only interpreter.
     *
     * It holds the **email**, never the in-app row: quiet hours are about a
     * phone at night, not about hiding what happened.
     */
    quietFrom: integer("quiet_from"),
    quietTo: integer("quiet_to"),
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
    /**
     * The earliest this may be emailed (W5-15). Null means "now".
     *
     * Set from the recipient's quiet window at the moment the row is written,
     * not consulted at send time — so a person who changes their quiet hours
     * does not retroactively silence or release alerts that were already
     * decided. Null rather than `now()` because "no delay was ever asked for"
     * is a different fact from "the delay expired a millisecond ago", and the
     * sender's predicate reads that way.
     */
    sendAfter: timestamp("send_after", { withTimezone: true }),
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
    /**
     * The provider's id for *this* subscription (W1.8), so a webhook can find
     * the row it is about rather than guessing from an organization and a
     * timestamp. Null for a trial, which nobody is paying for yet.
     */
    providerSubscriptionId: text("provider_subscription_id"),
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
    /**
     * Which gateway accepted it — the difference between a registered consent
     * and a development one.
     *
     * `iys_uploaded_at` alone would claim the registry holds this permission,
     * and in a dev or staging database that claim is false: the `local` adapter
     * accepts everything without leaving the machine. Storing the adapter's
     * name makes the two permanently distinguishable, so "which of these did a
     * real registry actually accept" stays an answerable question.
     */
    iysUploadedVia: text("iys_uploaded_via"),
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
export type ReviewStatus = (typeof reviewStatusEnum.enumValues)[number];
export type MemberLocation = typeof memberLocations.$inferSelect;
export type ReplyTemplate = typeof replyTemplates.$inferSelect;
export type SavedView = typeof savedViews.$inferSelect;
export type Widget = typeof widgets.$inferSelect;
export type ReviewInsight = typeof reviewInsights.$inferSelect;
export type NewReviewInsight = typeof reviewInsights.$inferInsert;
export type Sentiment = (typeof sentimentEnum.enumValues)[number];
export type Tag = typeof tags.$inferSelect;
export type ReviewTag = typeof reviewTags.$inferSelect;
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

/**
 * Every tenant-owned table — the set RLS must cover.
 *
 * Kept complete rather than as of Phase 0: the list is the checklist a reviewer
 * reads when adding a table, and one that silently stopped listing `replies`
 * and `notifications` is worse than no list at all.
 */
export const TENANT_TABLES = [
  "memberships",
  "locations",
  "connections",
  "reviews",
  "review_insights",
  "review_tags",
  "member_locations",
  "reply_templates",
  "saved_views",
  "widgets",
  "tags",
  "contacts",
  "contact_tags",
  "contact_segments",
  "campaigns",
  "review_requests",
  "surveys",
  "survey_responses",
  "whatsapp_conversations",
  "messages",
  "channel_connections",
  "integration_requests",
  "broadcasts",
  "broadcast_recipients",
  "agency_clients",
  "digests",
  "digest_actions",
  "digest_deliveries",
  "replies",
  "notification_preferences",
  "notifications",
  "subscriptions",
  "usage_counters",
  "audit_logs",
  "consent_records",
  "invitations",
  // Phase 3. These three carry RLS in migrations 0034 and 0035 but were never
  // added here — exactly the drift the note above warns about, found while
  // adding the Phase 4 tables.
  "report_schedules",
  "report_deliveries",
  "competitors",
] as const;
