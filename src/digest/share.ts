import type { DigestPdfContent } from "./pdf.ts";

/**
 * A digest, as something you can take somewhere else (W2.1).
 *
 * Two shapes, one source. The PDF is for reading and printing — a Monday staff
 * meeting, a noticeboard, a branch manager with no login. The text is for
 * **pasting into WhatsApp**, which is how a Turkish café owner actually
 * forwards anything, and it is the reason this is not simply a PDF download.
 *
 * Both are built here rather than in the route so the two cannot drift into
 * disagreeing about what a week said, and so the shape is testable without a
 * PDF renderer or a request.
 *
 * **Everything arrives preformatted.** This module has no locale, no `Intl` and
 * no translator — the caller has all three. What it owns is *what goes in and
 * in what order*, which is the part that must match the screen.
 */

/** The digest, already rendered into the reader's language by the caller. */
export type ShareableDigest = {
  scopeName: string;
  period: string;
  eyebrow: string;
  headline: string;
  summary: string;
  pulse: {
    label: string;
    value: string | null;
    meta: string;
    delta: string | null;
    direction: "up" | "down" | "flat" | null;
  };
  actionsTitle: string;
  actions: {
    position: number;
    text: string;
    /** The customer's words, with their stars already prefixed. */
    quote: string | null;
    meta: string | null;
  }[];
  actionsEmpty: string;
  changesTitle: string;
  changes: { key: string; text: string; direction: "up" | "down" | "flat" }[];
  themesTitle: string;
  themes: { key: string; label: string; meta: string }[];
  footer: string;
};

/** The PDF's content is the shareable digest unchanged — one shape, two renderers. */
export function digestPdfContent(digest: ShareableDigest): DigestPdfContent {
  return digest;
}

/**
 * The same briefing as plain text, for a message.
 *
 * **No markdown.** WhatsApp, SMS and a paste into Notes all render `**bold**`
 * literally, and a plan peppered with asterisks reads as broken rather than as
 * emphasised. Structure comes from blank lines and numbering, which survive
 * everywhere.
 *
 * The link is deliberately **not** included: `/weekly-plan/{id}` needs a session, so
 * pasting it to somebody outside the team sends them to a sign-in page. A
 * share that lands on a login screen is worse than one that does not offer a
 * link at all.
 */
export function digestShareText(digest: ShareableDigest): string {
  const lines: string[] = [`${digest.scopeName} — ${digest.period}`, "", digest.headline];

  if (digest.summary) lines.push("", digest.summary);

  if (digest.pulse.value) {
    lines.push(
      "",
      // "İtibar puanı: 86/100 · 31 yorum · geçen haftaya göre +5,2"
      [`${digest.pulse.label}: ${digest.pulse.value}`, digest.pulse.meta, digest.pulse.delta]
        .filter((part): part is string => Boolean(part))
        .join(" · "),
    );
  }

  lines.push("", digest.actionsTitle);
  if (digest.actions.length === 0) {
    lines.push(digest.actionsEmpty);
  } else {
    for (const action of digest.actions) {
      lines.push(`${action.position}. ${action.text}`);
      // Indented, so a wrapped quote still reads as subordinate to its action
      // in a client that does nothing but wrap.
      if (action.quote) lines.push(`   ${action.quote}`);
    }
  }

  if (digest.changes.length > 0) {
    lines.push("", digest.changesTitle);
    for (const change of digest.changes) lines.push(`· ${change.text}`);
  }

  if (digest.themes.length > 0) {
    lines.push("", digest.themesTitle);
    for (const theme of digest.themes) lines.push(`· ${theme.label} — ${theme.meta}`);
  }

  lines.push("", digest.footer);

  return lines.join("\n");
}
