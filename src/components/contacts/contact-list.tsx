import { Mail, MailX, Phone } from "lucide-react";
import Link from "next/link";
import { Avatar } from "@/components/ds/avatar";
import { Badge } from "@/components/ui/badge";

/**
 * The contact list (P4-T1).
 *
 * A list of rows rather than a `<table>`, deliberately. The screen has to work
 * at 390px, where a five-column table either scrolls sideways or squeezes an
 * email address to three characters — and none of these columns is one anybody
 * compares down a column the way they compare a benchmark. So each row is a
 * card on a phone and a grid from `sm` up, and the whole row is one link.
 *
 * Every string arrives already formatted. Functions cannot cross the RSC
 * boundary, and a client component re-deriving a locale is how `/analytics`
 * ended up formatting the same number two ways (P3-T4).
 */

export type ContactListRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  unsubscribed: boolean;
  /** A live local İYS permission is on file for this channel. */
  emailConsent: boolean;
  messageConsent: boolean;
  tags: { slug: string; label: string }[];
  reviewCount: number;
  /** Already localised, or null when nothing has happened yet. */
  lastActivity: string | null;
};

export function ContactList({
  rows,
  labels,
}: {
  rows: ContactListRow[];
  labels: {
    /** Shown in place of a name we do not have. */
    unnamed: string;
    unsubscribed: string;
    reviews: (count: number) => string;
    noActivity: string;
    moreTags: (count: number) => string;
    /** "Email OK" / "WhatsApp OK" — what is on file, not permission to send. */
    emailConsent: string;
    messageConsent: string;
  };
}) {
  return (
    <ul className="divide-y divide-line-soft rounded-lg border border-line bg-card">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            href={`/contacts/${row.id}`}
            className="flex items-start gap-3 px-(--card-px) py-3 transition-colors hover:bg-surface-hover focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset"
          >
            {/*
              The same monogram the review row uses — one component, one hash,
              so a person is the same circle on every screen they appear on. A
              list of names with no anchor is a wall of text, which is what this
              row was: a name, an address floating in the middle, and two grey
              figures at the right.
            */}
            <Avatar name={row.name} className="mt-0.5" />

            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-copy font-semibold text-foreground">
                  {row.name ?? labels.unnamed}
                </span>

                {row.unsubscribed ? (
                  <Badge variant="destructive">
                    <MailX aria-hidden />
                    {labels.unsubscribed}
                  </Badge>
                ) : null}

                {/*
                  **Consent, on the row.**

                  "May I message this person" is the first question anybody asks
                  on a contacts screen in a product whose compliance model is
                  İYS — and it was answerable only by applying a filter and
                  seeing whether the row survived. The opt-out was shown, so the
                  list could say *no* and never *yes*.

                  This reports what is on file. It is not permission to send:
                  `checkSendAllowed` decides that at the moment of sending,
                  because it also asks the registry and re-reads the opt-out. A
                  screen may report the record; only the gate may act on it.

                  Suppressed when the contact has unsubscribed — an opt-out
                  beats any permission, and showing both reads as a
                  contradiction.
                */}
                {!row.unsubscribed && row.emailConsent ? (
                  <Badge variant="positive">{labels.emailConsent}</Badge>
                ) : null}
                {!row.unsubscribed && row.messageConsent ? (
                  <Badge variant="positive">{labels.messageConsent}</Badge>
                ) : null}

                {/*
                  Three tags, then a count. A contact may carry twelve, and a
                  row that reflows because somebody is thorough stops being
                  scannable. Beside the name rather than in a far-right column:
                  a label is part of who this person is to the business.
                */}
                {row.tags.slice(0, 3).map((tag) => (
                  <Badge key={tag.slug} variant="secondary">
                    {tag.label}
                  </Badge>
                ))}
                {row.tags.length > 3 ? (
                  <Badge variant="secondary">{labels.moreTags(row.tags.length - 3)}</Badge>
                ) : null}
              </div>

              {/* Contact details on one line, not stacked: they are the same
                  kind of fact and stacking them made a two-line row out of an
                  address and a number. */}
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-meta text-ink-400">
                {row.email ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Mail className="size-3 shrink-0 text-graphic-faint" aria-hidden />
                    <span className="truncate">{row.email}</span>
                  </span>
                ) : null}
                {row.phone ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Phone className="size-3 shrink-0 text-graphic-faint" aria-hidden />
                    <span className="truncate">{row.phone}</span>
                  </span>
                ) : null}
              </div>
            </div>

            {/* History, in its own column so it aligns down the list. */}
            <div className="flex w-[9rem] shrink-0 flex-col items-end gap-0.5 text-meta text-faint">
              <span className="whitespace-nowrap">{row.lastActivity ?? labels.noActivity}</span>
              {row.reviewCount > 0 ? (
                <span className="whitespace-nowrap">{labels.reviews(row.reviewCount)}</span>
              ) : null}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
