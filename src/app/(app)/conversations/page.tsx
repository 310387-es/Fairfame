import { MessageSquare } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { resolveLocationScope } from "@/auth/scope";
import { requireActor } from "@/auth/session";
import { Composer, type ComposerTemplate } from "@/components/conversations/composer";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { TEMPLATES } from "@/connectors/whatsapp/templates";
import { getLocale } from "next-intl/server";
import { isLocale, DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { can } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";
import { getContact } from "@/contacts/queries";
import { listConversations, listThread, windowState } from "@/messaging/messages";
import { cn } from "@/lib/utils";

/**
 * The conversations inbox (P4-T3).
 *
 * Two panes and a URL: the list of people, and the thread with whichever one
 * `?c=` names. Selection lives in the query string for the same reasons every
 * other filter in the product does — it survives a refresh, it can be shared
 * with a colleague, and the contact profile can link straight to a conversation.
 *
 * `docs/20` calls this an inbox and it deliberately is not a second one. It has
 * no triage, no assignment and no SLA: those belong to reviews, where an item
 * arrives once and has to be dealt with. A conversation is not a work item, it
 * is a person, and the signal that matters — *they wrote last and nobody has
 * answered* — is derived from the thread rather than stored as a status
 * somebody has to remember to clear.
 */

type PageProps = { searchParams: Promise<{ c?: string }> };

function localeOf(value: string): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export default async function MessagesPage({ searchParams }: PageProps) {
  const [query, actor, t, format, rawLocale] = await Promise.all([
    searchParams,
    requireActor(),
    getTranslations("messages"),
    getFormatter(),
    getLocale(),
  ]);

  const locale = localeOf(rawLocale);
  const now = new Date();

  const data = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const org = { organizationId: actor.organizationId, tx };
      if (!(await can(org, "messaging"))) return { unlocked: false as const };

      const scope = await resolveLocationScope(tx, actor.organizationId, actor.userId, actor.role);
      const conversations = await listConversations(tx, actor.organizationId, scope, now);

      /**
       * The named conversation, the most recent one, or — when `?c=` names
       * somebody nobody has exchanged a word with yet — a conversation that
       * does not exist.
       *
       * That last case is how a conversation *starts*: the contact profile
       * links here, and the thread pane opens empty with the composer under it.
       * The alternative was a "new message" picker listing every contact, which
       * is a second way to do the same thing and a second place to get the
       * scope check right.
       */
      let selected = conversations.find((row) => row.contactId === query.c) ?? null;

      if (!selected && query.c) {
        // Scoped exactly as the list is — `getContact` builds its clause from
        // `src/contacts/scope.ts`, so a member cannot open a conversation with
        // somebody /contacts hides from them by editing the query string.
        const contact = await getContact({
          tx,
          organizationId: actor.organizationId,
          scope,
          contactId: query.c,
        });

        if (contact) {
          selected = {
            contactId: contact.id,
            contactName: contact.name,
            phone: contact.phone,
            channel: "whatsapp",
            lastBody: null,
            lastDirection: "outbound",
            lastAt: now,
            windowOpen: null,
          };
        }
      }

      selected ??= conversations[0] ?? null;

      if (!selected) return { unlocked: true as const, conversations, selected: null };

      return {
        unlocked: true as const,
        conversations,
        selected,
        thread: await listThread(tx, actor.organizationId, selected.contactId),
        window: await windowState(tx, actor.organizationId, selected.contactId, now),
      };
    },
  );

  if (!data.unlocked) {
    return (
      <>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <SectionCard title={t("locked.title")} icon={MessageSquare}>
          <p className="pb-(--card-py) text-body text-ink-400">{t("locked.body")}</p>
        </SectionCard>
      </>
    );
  }

  const { conversations, selected } = data;

  if (!selected) {
    return (
      <>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <SectionCard title={t("empty.title")} icon={MessageSquare}>
          <p className="pb-(--card-py) text-body text-ink-400">{t("empty.body")}</p>
        </SectionCard>
      </>
    );
  }

  const thread = data.thread ?? [];
  const windowInfo = data.window ?? { open: false, lastInboundAt: null };

  /**
   * The templates, rendered in the reader's language with their placeholders
   * intact, so the picker shows the message rather than a name.
   */
  const templates: ComposerTemplate[] = Object.values(TEMPLATES).map((template) => ({
    name: template.name,
    preview: template.body[locale],
    variables: [...template.variables],
  }));

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="grid gap-(--grid-gap) lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:items-start">
        <SectionCard title={t("conversations")} icon={MessageSquare} flush>
          <ul className="divide-y divide-line-soft">
            {conversations.map((row) => {
              const active = row.contactId === selected.contactId;
              // Derived, not stored: they wrote last and nobody has answered.
              const awaiting = row.lastDirection === "inbound";

              return (
                <li key={row.contactId}>
                  <Link
                    href={`/conversations?c=${row.contactId}`}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex flex-col gap-0.5 px-(--card-px) py-2.5 transition-colors",
                      "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset",
                      active ? "bg-surface-sunken" : "hover:bg-surface-sunken",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-copy font-semibold text-foreground">
                        {row.contactName ?? row.phone ?? t("unnamed")}
                      </span>
                      {awaiting ? <Badge variant="accent">{t("awaiting")}</Badge> : null}
                      <time
                        dateTime={row.lastAt.toISOString()}
                        className="ml-auto shrink-0 text-meta text-faint"
                      >
                        {format.relativeTime(row.lastAt, now)}
                      </time>
                    </div>
                    <p className="truncate text-meta text-ink-400">{row.lastBody ?? "—"}</p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </SectionCard>

        <SectionCard
          title={selected.contactName ?? selected.phone ?? t("unnamed")}
          icon={MessageSquare}
          meta={t(selected.channel === "whatsapp" ? "channelWhatsapp" : "channelSms")}
          link={{ href: `/contacts/${selected.contactId}`, label: t("openContact") }}
          flush
        >
          <ol className="flex flex-col gap-2 px-(--card-px) pb-3">
            {thread.map((message) => {
              const outbound = message.direction === "outbound";

              return (
                <li
                  key={message.id}
                  className={cn("flex flex-col gap-0.5", outbound ? "items-end" : "items-start")}
                >
                  <div
                    className={cn(
                      "max-w-[85%] rounded-lg px-3 py-2 text-body text-pretty",
                      outbound
                        ? message.status === "failed"
                          ? "bg-state-negative-bg text-state-negative-text"
                          : "bg-primary text-primary-foreground"
                        : "bg-surface-sunken text-foreground",
                    )}
                  >
                    {message.body ?? "—"}
                  </div>

                  <p className="flex items-center gap-1.5 text-meta text-faint">
                    <time dateTime={message.createdAt.toISOString()}>
                      {format.dateTime(message.createdAt, "short")}
                    </time>
                    {/*
                      The basis it went out on, in the thread. `docs/20`'s first
                      compliance rule is about what a business may send; being
                      able to see, per message, which permission carried it is
                      what makes that auditable rather than merely enforced.
                    */}
                    {outbound && message.intent ? (
                      <span>
                        · {t(message.intent === "service" ? "intentService" : "intentCommercial")}
                      </span>
                    ) : null}
                    {outbound ? <span>· {t(`status.${message.status}`)}</span> : null}
                    {message.templateName ? <span>· {message.templateName}</span> : null}
                  </p>

                  {message.failureReason ? (
                    <p className="text-meta text-state-negative-text">{message.failureReason}</p>
                  ) : null}
                </li>
              );
            })}
          </ol>

          <Composer
            contactId={selected.contactId}
            channel={selected.channel}
            windowOpen={selected.windowOpen}
            windowClosesAt={
              windowInfo.lastInboundAt
                ? format.dateTime(
                    new Date(windowInfo.lastInboundAt.getTime() + 24 * 60 * 60 * 1_000),
                    "short",
                  )
                : null
            }
            templates={templates}
            // A contact with no number cannot be messaged, and the composer has
            // to say so *before* anything is typed. It was hardcoded `true`, so
            // opening a conversation with a phoneless contact — which the
            // contact profile linked to even while saying it was impossible —
            // offered a working composer whose every send would fail with
            // `no_address` after the message had been written.
            canSend={selected.phone !== null}
            blockedReason={selected.phone === null ? "no_address" : null}
          />
        </SectionCard>
      </div>
    </>
  );
}
