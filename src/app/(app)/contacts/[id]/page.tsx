import { History, Mail, MessageSquare, Phone, ShieldCheck, Tag, Users } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { resolveLocationScope } from "@/auth/scope";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { getIysGateway } from "@/compliance/gate";
import { ConsentPanel } from "@/components/contacts/consent-panel";
import { ContactAdmin } from "@/components/contacts/contact-admin";
import { ContactTagsEditor } from "@/components/contacts/contact-tags-editor";
import { ContactTimeline } from "@/components/contacts/contact-timeline";
import { Eyebrow } from "@/components/ds/eyebrow";
import { Metric } from "@/components/ds/metric";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { listContactConsent } from "@/contacts/consent";
import { getContact } from "@/contacts/queries";
import { listContactTags } from "@/contacts/tags";
import { contactTimeline } from "@/contacts/timeline";
import { can } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";

/**
 * One contact (P4-T1).
 *
 * Three questions in order, which is the order somebody opening this page asks
 * them in: **who is this** (identity, tags, whether they have opted out),
 * **what are we allowed to do** (consent, per channel, and whether it ever
 * reached the registry), and **what has happened** (the timeline).
 *
 * Visibility comes from `getContact`, which builds its clause from
 * `src/contacts/scope.ts` — the same one the list uses. That is what stops the
 * bug where a row is hidden from the list and still readable by URL.
 */

type PageProps = { params: Promise<{ id: string }> };

export default async function ContactPage({ params }: PageProps) {
  const [{ id }, actor, t, format] = await Promise.all([
    params,
    requireActor(),
    getTranslations("contacts"),
    getFormatter(),
  ]);

  const data = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const org = { organizationId: actor.organizationId, tx };
      if (!(await can(org, "crm"))) return null;

      const canMessage = await can(org, "messaging");
      const scope = await resolveLocationScope(tx, actor.organizationId, actor.userId, actor.role);
      const contact = await getContact({
        tx,
        organizationId: actor.organizationId,
        scope,
        contactId: id,
      });
      if (!contact) return null;

      return {
        contact,
        canMessage,
        consents: await listContactConsent(tx, actor.organizationId, contact.id),
        timeline: await contactTimeline(tx, actor.organizationId, contact),
        vocabulary: await listContactTags(tx, actor.organizationId),
      };
    },
  );

  // One 404 for "no such contact", "not yours to see" and "not on your plan".
  // Distinguishing them would leak the thing each of them is withholding.
  if (!data) notFound();

  const { contact, canMessage, consents, timeline, vocabulary } = data;
  const canManage = roleAtLeast(actor.role, "admin");

  const onContact = new Set(contact.tags.map((tag) => tag.slug));
  const suggestions = vocabulary
    .filter((tag) => !onContact.has(tag.slug))
    .map((tag) => ({ slug: tag.slug, label: tag.label }));

  return (
    <>
      <PageHeader
        title={contact.name ?? t("unnamed")}
        subtitle={t("profileSubtitle")}
        back={{ href: "/contacts", label: t("backToContacts") }}
      />

      <div className="grid gap-(--grid-gap) lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:items-start">
        <div className="flex flex-col gap-(--grid-gap)">
          <SectionCard title={t("identity")} icon={Users}>
            <div className="flex flex-col gap-2 pb-(--card-py)">
              {contact.unsubscribedAt ? (
                <Badge variant="destructive" className="w-fit">
                  {t("unsubscribedOn", {
                    date: format.dateTime(contact.unsubscribedAt, "short"),
                  })}
                </Badge>
              ) : null}

              {contact.email ? (
                <p className="flex min-w-0 items-center gap-2 text-body text-ink-400">
                  <Mail className="size-4 shrink-0 text-graphic-faint" aria-hidden />
                  <span className="truncate">{contact.email}</span>
                </p>
              ) : null}
              {contact.phone ? (
                <p className="flex min-w-0 items-center gap-2 text-body text-ink-400">
                  <Phone className="size-4 shrink-0 text-graphic-faint" aria-hidden />
                  <span className="truncate">{contact.phone}</span>
                </p>
              ) : null}

              <div className="grid grid-cols-2 gap-3 pt-1">
                <div className="flex flex-col gap-0.5">
                  <Eyebrow>{t("reviewsGiven")}</Eyebrow>
                  <Metric>{contact.reviewCount}</Metric>
                </div>
                <div className="flex flex-col gap-0.5">
                  <Eyebrow>{t("firstSeen")}</Eyebrow>
                  {/* Not a `Metric`: a date is not a quantity, and setting one
                      at 28px would make "5 Aug 2026" the loudest thing here. */}
                  <span className="text-body text-foreground">
                    {format.dateTime(contact.createdAt, "short")}
                  </span>
                </div>
              </div>
            </div>
          </SectionCard>

          <SectionCard title={t("tags")} icon={Tag}>
            <ContactTagsEditor
              contactId={contact.id}
              tags={contact.tags}
              suggestions={suggestions}
              canEdit
            />
          </SectionCard>

          {/*
            The way into a conversation (P4-T3). A link rather than a composer
            on this page: the thread is the context a reply needs, and two
            places to type a message is two places for the window rules to be
            explained differently.
          */}
          {canMessage ? (
            <SectionCard
              title={t("conversation")}
              icon={MessageSquare}
              link={{ href: `/messages?c=${contact.id}`, label: t("openConversation") }}
            >
              <p className="pb-(--card-py) text-body text-ink-400">
                {contact.phone ? t("conversationHint") : t("conversationNoPhone")}
              </p>
            </SectionCard>
          ) : null}

          <SectionCard title={t("consent.title")} icon={ShieldCheck}>
            <ConsentPanel consents={consents} registryName={getIysGateway()?.name ?? null} />
          </SectionCard>

          <SectionCard title={t("manage")} icon={Users}>
            <ContactAdmin
              contactId={contact.id}
              name={contact.name}
              unsubscribed={contact.unsubscribedAt !== null}
              canManage={canManage}
            />
          </SectionCard>
        </div>

        <SectionCard title={t("timeline")} icon={History}>
          <ContactTimeline events={timeline} />
        </SectionCard>
      </div>
    </>
  );
}
