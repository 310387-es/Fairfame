import { Mail, MailX, Phone } from "lucide-react";
import Link from "next/link";
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
 * boundary, and a client component re-deriving a locale is how `/insights`
 * ended up formatting the same number two ways (P3-T4).
 */

export type ContactListRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  unsubscribed: boolean;
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
  };
}) {
  return (
    <ul className="divide-y divide-line-soft rounded-lg border border-line bg-card">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            href={`/contacts/${row.id}`}
            className="grid gap-1.5 px-(--card-px) py-3 transition-colors hover:bg-surface-sunken focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)] sm:items-center sm:gap-3"
          >
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
            </div>

            <div className="flex min-w-0 flex-col gap-0.5 text-meta text-ink-400">
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

            <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
              {/*
                Three tags, then a count. A contact may carry twelve, and a row
                that reflows to four lines because somebody is thorough is a
                list that stops being scannable.
              */}
              {row.tags.slice(0, 3).map((tag) => (
                <Badge key={tag.slug} variant="secondary">
                  {tag.label}
                </Badge>
              ))}
              {row.tags.length > 3 ? (
                <Badge variant="secondary">{labels.moreTags(row.tags.length - 3)}</Badge>
              ) : null}

              <span className="text-meta whitespace-nowrap text-faint">
                {row.reviewCount > 0 ? labels.reviews(row.reviewCount) : null}
              </span>
              <span className="text-meta whitespace-nowrap text-faint">
                {row.lastActivity ?? labels.noActivity}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
