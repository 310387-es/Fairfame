-- Contacts / light CRM (P4-T1, docs/20-phase-4-build-plan.md).
--
-- `contacts` itself already exists — it landed with first-party collection in
-- P1b-T1 as "the one place a customer's email or phone is stored", which is
-- what makes a KVKK erasure request one row rather than a hunt through jsonb.
-- Phase 4 does not redefine it. It adds the two things a contact record needs
-- before it is a CRM rather than a mailing list: **labels a business puts on
-- people**, and **saved filters over them**.
--
-- Nothing here stores a second copy of anyone's identity. A tag is a word; a
-- segment is a query. Both cascade with the contact and the organization.

-- ---------------------------------------------------------------------------
-- Tags on a contact
-- ---------------------------------------------------------------------------
--
-- **One table, where reviews needed two.** `review_tags` points at `tags`, a
-- curated vocabulary row, and that indirection earns its keep there: `tags`
-- carries a running `review_count` so the themes list does not aggregate on
-- every render, and a `merged_into_id` so two themes can be folded together.
-- Contact labels have neither. A vocabulary table here would exist only to hold
-- a string that this table already holds.
--
-- What the vocabulary table *did* buy is worth keeping, so it is kept without
-- the table: the `slug` column is the normalised form (src/contacts/tags.ts
-- reuses the Turkish-aware slugifier from src/seo/slug.ts), and it — not the
-- label — is what uniqueness and filtering key on. Tagging one person "VIP" and
-- another "vip " produces one segment, not two. `label` is what the business
-- typed, and applying a slug the organization already uses adopts the existing
-- label rather than forking it, so a rename stays a single UPDATE over this
-- table.
CREATE TABLE "contact_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	-- Normalised. The thing filters and segments match on.
	"slug" text NOT NULL,
	-- As typed, and shown as typed.
	"label" text NOT NULL,
	-- Who applied it. Null once they leave: the label outlives the person, the
	-- same way `review_tags.tagged_by_user_id` does.
	"tagged_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Applying the same label twice is not two labels.
	CONSTRAINT "contact_tags_contact_slug_key" UNIQUE ("contact_id", "slug"),
	-- An empty tag is a tag nobody can search for or remove by name.
	CONSTRAINT "contact_tags_slug_not_blank" CHECK (length("slug") > 0)
);
--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tagged_by_user_id_users_id_fk" FOREIGN KEY ("tagged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- "who is tagged VIP" — the filter, and the vocabulary list, both read this.
CREATE INDEX "contact_tags_org_slug_idx" ON "contact_tags" USING btree ("organization_id","slug");--> statement-breakpoint
-- "what is this person tagged" — the contact profile.
CREATE INDEX "contact_tags_contact_idx" ON "contact_tags" USING btree ("contact_id");--> statement-breakpoint

ALTER TABLE public.contact_tags ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.contact_tags FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.contact_tags
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_tags TO fairfame_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Segments — a saved contact filter
-- ---------------------------------------------------------------------------
--
-- Modelled on `saved_views` (P2-T3) and storing the same thing the same way:
-- the **query string**, as a flat record of strings, so the tolerant parser that
-- reads the URL is also the validator for what was stored. A filter dropped in a
-- later release degrades to "ignore that key" rather than needing a backfill.
--
-- **No `owner_user_id`, and that is the one real departure.** A saved view is a
-- way of looking at a queue, so a private one makes sense. A segment is an
-- *audience*: P4-T4 points campaigns at these, and a campaign that sends real
-- messages to "Ayşe's private list" is not a thing an organization can answer
-- for afterwards. So a segment belongs to the organization, creating one needs
-- admin, and there is no shape in which a personal audience can exist.
CREATE TABLE "contact_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	-- The contact filter state, as query-string pairs. Validated on read by
	-- src/contacts/filters.ts — never trusted as a shape.
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	-- Display order in the chip row. Ties break on name.
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_segments_org_name_key" UNIQUE ("organization_id", "name")
);
--> statement-breakpoint
ALTER TABLE "contact_segments" ADD CONSTRAINT "contact_segments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segments" ADD CONSTRAINT "contact_segments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_segments_org_position_idx" ON "contact_segments" USING btree ("organization_id","position");--> statement-breakpoint

ALTER TABLE public.contact_segments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.contact_segments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.contact_segments
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_segments TO fairfame_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Reading the contact list
-- ---------------------------------------------------------------------------
--
-- The default order is newest first, per tenant.
CREATE INDEX "contacts_org_created_at_idx" ON "contacts" USING btree ("organization_id","created_at" DESC);--> statement-breakpoint

-- Searching by name, folded exactly the way review search is folded (migration
-- 0022): `lower(immutable_unaccent(…))`, so "Sule" finds "Şule" and "ŞULE"
-- finds both. A contact list that could not do that in the launch market would
-- be a list people scroll rather than search.
--
-- Email and phone are matched with the same expression and deliberately get no
-- index: both are looked up by prefix or in full, they are far more selective
-- than a name, and a trigram index over every stored address is a large object
-- to maintain for a query that already narrows to one tenant first.
CREATE INDEX "contacts_name_trgm_idx"
  ON "contacts" USING gin (lower("immutable_unaccent"("name")) gin_trgm_ops);
