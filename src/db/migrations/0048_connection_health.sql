-- Connection health, and demand for the sources we do not have (W4.2).
--
-- ## `last_error_kind`
--
-- The Connections screen has to say *why* a source is unwell, and the four
-- answers a business can act on are different acts: reconnect it, wait, fix the
-- permissions, or tell us. Today the only evidence on the row is `last_error` —
-- `error.message`, sliced to 500 characters, written by whatever threw.
--
-- The type is where the meaning lives (`RateLimitError`, `OAuthError`,
-- `GoogleAccessError`) and it is exactly what `instanceof` knows and a string
-- column forgets. Deriving a health badge by matching substrings of a provider's
-- prose would work until Meta reworded a message, and then it would go on
-- rendering "Healthy" over a connection that had been dead for a month —
-- failing silently, in the direction that looks fine.
--
-- Nullable and unconstrained on purpose: it is a *hint* for a badge, never a
-- branch anything important takes. `src/connections/health.ts` treats an
-- unrecognised value exactly as it treats null.
ALTER TABLE "connections" ADD COLUMN "last_error_kind" text;--> statement-breakpoint

-- ## `integration_requests`
--
-- The Connections screen lists sources we have not built — Facebook, Trustpilot,
-- Yemeksepeti, TripAdvisor — because a business needs to know whether we are
-- ever going to read their Yemeksepeti reviews, and an empty grid answers that
-- question with silence.
--
-- Offering "Request this integration" and then dropping the press on the floor
-- would be worse than not offering it, so it is a row. One per organization per
-- source: this is a signal, not a petition, and letting somebody press it forty
-- times would make the count useless for the only thing it is for — deciding
-- what to build next.
--
-- `provider_key` is deliberately **not** a foreign key and deliberately not an
-- enum. These keys name things that do not exist in `PROVIDERS` and must never
-- be added to it (see `src/connectors/roadmap.ts`): a descriptor with no
-- connector behind it is a connect button that throws.
CREATE TABLE "integration_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider_key" text NOT NULL,
  -- Who asked. Kept when they leave (ON DELETE SET NULL) — the demand signal
  -- outlives the employee, and losing it would quietly deflate the count.
  "requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX "integration_requests_org_provider_key"
  ON "integration_requests" ("organization_id", "provider_key");--> statement-breakpoint

ALTER TABLE public.integration_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.integration_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.integration_requests
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.integration_requests TO revira_app;
