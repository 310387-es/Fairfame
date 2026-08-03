-- Row-Level Security for `whatsapp_conversations` (P1b-T3).
--
-- Same model as every tenant table before it: ENABLE + FORCE, keyed on the
-- transaction-local `app.current_org` GUC.
--
-- This table decides whether a business may send a customer a free-form
-- message, so a cross-tenant read is not merely a privacy problem — it would
-- let one organization's inbound traffic authorise another's outbound send.
-- The row is also, by itself, evidence that a specific phone number contacted a
-- specific business.

ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.whatsapp_conversations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.whatsapp_conversations
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_conversations TO revira_app;
