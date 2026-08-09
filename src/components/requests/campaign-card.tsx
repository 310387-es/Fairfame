"use client";

import { Archive, Check, Copy, Download, ExternalLink, Printer, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Eyebrow } from "@/components/ds/eyebrow";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RecipientPicker } from "@/components/requests/recipient-picker";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useAction } from "@/components/ui/use-action";
import { archiveCampaignAction, sendRequestsAction } from "@/server/campaigns";

/**
 * One campaign: its public link, its QR code, its funnel, and — for an email
 * campaign — the box you paste customer addresses into.
 *
 * The QR arrives as pre-rendered SVG markup from the server. Generating it here
 * would mean shipping an encoder to the browser to draw something that never
 * changes.
 */

/**
 * What the card calls each channel (A22-A2).
 *
 * It was a ternary — email, or else "link" — which was right while those were
 * the only two the form could produce and became a lie the moment WhatsApp and
 * SMS could be chosen: a WhatsApp campaign introduced itself as a QR code. A
 * map rather than another branch, so the next channel is one line and an
 * unknown one still reads as something rather than blank.
 */
const CHANNEL_LABELS: Record<string, string> = {
  email: "channelEmail",
  whatsapp: "channelWhatsapp",
  sms: "channelSms",
  link: "channelLink",
};

export type CampaignCardProps = {
  campaign: {
    id: string;
    name: string;
    locationName: string;
    channel: string;
    status: string;
    destination: string;
    destinationUrl: string | null;
    url: string;
    qrSvg: string;
    funnel: { sent: number; opened: number; submitted: number };
  };
  canManage: boolean;
};

export function CampaignCard({ campaign, canManage }: CampaignCardProps) {
  const t = useTranslations("requests");
  const tf = useTranslations("feedback");
  const [copied, setCopied] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const { run, pending } = useAction();
  const formRef = useRef<HTMLFormElement>(null);

  const archived = campaign.status === "archived";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(campaign.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be denied; the link is on screen either way.
    }
  }

  /*
    Whether this card has a second job.

    A `link` campaign has nothing to send — its whole affordance is the QR on a
    table — and an archived one, or one an ordinary member is looking at, has
    nothing to send either. In those cases the card is only "here is your link"
    and must not reserve half its width for a column that is not there.
  */
  const showSend = campaign.channel !== "link" && canManage && !archived;

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* The one place 17px is genuinely right: a card's own title, above
                `title` and well below `metric`. It named no size at all before. */}
            <p className="truncate text-[17px] font-semibold">{campaign.name}</p>
            <p className="truncate text-body text-muted-foreground">
              {campaign.locationName} · {t(CHANNEL_LABELS[campaign.channel] ?? "channelLink")}
            </p>
          </div>
          {/* Active is a state, not a control — the positive pair, not indigo. */}
          <Badge variant={archived ? "secondary" : "positive"}>
            {archived ? t("statusArchived") : t("statusActive")}
          </Badge>
        </div>

        {/*
          Two jobs, side by side: **share** this campaign, and **send** it.

          Both used to be stacked in a single column, and the page put two of
          these cards across — so at 1500px each card had 520px, the five share
          buttons wrapped with "Open page" orphaned on its own line, and the
          recipient picker and address box sat underneath it all while 990px of
          the page stayed white. The card was narrow because the *page* was
          two-up; the page is one-up now (`/get-reviews`), and the width goes
          where the content is.

          The split is by task rather than by size. Handing somebody a link and
          mailing a list of customers are different things a business does on
          different days, and stacking them made the second one look like a
          continuation of the first.
        */}
        <div className={cn("grid gap-5", showSend && "lg:grid-cols-2 lg:gap-8")}>
          <div className="flex min-w-0 flex-col gap-5">
            {/*
          A three-cell funnel, drawn exactly like the one in `FunnelStrip` two
          hundred pixels up the page. It used to be a third convention: micro-caps
          labels over 17px **mono** numerals, against that strip's 13px sans and
          Home's `Metric` (`text-metric`, tabular, no mono). Three renderings of
          "a small number with a label" on one product, two of them on one screen.
          The comment here even claimed it matched Home. It did not.
        */}
            <dl className="grid grid-cols-3 gap-2 rounded-md bg-surface-sunken p-3 text-center">
              {(
                [
                  ["funnelSent", campaign.funnel.sent],
                  ["funnelOpened", campaign.funnel.opened],
                  ["funnelSubmitted", campaign.funnel.submitted],
                ] as const
              ).map(([key, value]) => (
                <div key={key}>
                  <Eyebrow asChild>
                    <dt>{t(key)}</dt>
                  </Eyebrow>
                  <dd className="mt-1 text-lead font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>

            <div className="flex gap-4">
              {/* Server-rendered SVG: a QR code is static, so this is markup, not
              a component with behaviour. */}
              <div
                aria-label={t("qrAlt")}
                role="img"
                className="size-24 shrink-0 [&>svg]:size-full"
                dangerouslySetInnerHTML={{ __html: campaign.qrSvg }}
              />

              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Label className="text-copy text-muted-foreground">{t("link")}</Label>
                {/*
              `wrap-anywhere`, not `truncate` (P1-12).

              A public link has no spaces, so `white-space: nowrap` made this
              element's *min-content* the width of the whole URL — and a grid
              item cannot shrink below its min-content. The card came out 541px
              wide on a 390px phone, pushing the whole page sideways. Hiding the
              overflow did not help: `truncate` clips what is painted and
              changes nothing about the width the layout asks for.

              `overflow-wrap: anywhere` is the one that also collapses
              min-content, which is why it fixes the layout where `break-word`
              would not. It is the same treatment the hosted-page URL on
              `/locations` already had — which is why that screen was the
              cheaper of the two to fix.
            */}
                <code className="rounded-md bg-muted px-2 py-1 text-copy wrap-anywhere">
                  {campaign.url}
                </code>

                {/*
                  Two rows, grouped by what you do with the campaign, rather
                  than five buttons in a `flex-wrap` that broke wherever the
                  card happened to end.

                  It wrapped after the fourth, so "Copy the link" sat beside
                  "Download QR" and "Open page" was orphaned on a line of its
                  own — the accidental grouping put a clipboard action next to
                  two print actions and separated it from its own twin. Reading
                  it, there is no way to tell that the break means nothing.

                  The split is the two things a business actually does: hand
                  somebody the link, or put it on a wall. Printing gets a named
                  group because W4.5 measured the QR poster as the highest
                  return-to-effort item in the audit, and it was button three
                  of five with nothing saying so.
                */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={copyLink}>
                    {copied ? (
                      <Check className="size-4" aria-hidden />
                    ) : (
                      <Copy className="size-4" aria-hidden />
                    )}
                    {copied ? t("copied") : t("copy")}
                  </Button>
                  <Button asChild size="sm" variant="ghost">
                    <a href={campaign.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-4" aria-hidden />
                      {t("openPage")}
                    </a>
                  </Button>
                </div>

                {/*
                  Plain links with `download`: the browser knows how to save a
                  response carrying a `Content-Disposition`, and the alternative
                  is holding a PDF in memory and minting an object URL for no
                  gain. Three links rather than a menu — a dropdown to choose
                  between three things a business prints once is a click spent
                  on nothing.
                */}
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <Eyebrow className="mr-1">{t("printGroup")}</Eyebrow>
                  <Button asChild size="sm" variant="ghost">
                    <a href={`/api/campaigns/${campaign.id}/qr`} download>
                      <Download className="size-4" aria-hidden />
                      {t("downloadQr")}
                    </a>
                  </Button>
                  <Button asChild size="sm" variant="ghost">
                    <a href={`/get-reviews/poster?campaign=${campaign.id}&layout=poster`} download>
                      <Printer className="size-4" aria-hidden />
                      {t("posterLabel")}
                    </a>
                  </Button>
                  <Button asChild size="sm" variant="ghost">
                    <a href={`/get-reviews/poster?campaign=${campaign.id}&layout=tent`} download>
                      <Printer className="size-4" aria-hidden />
                      {t("tableTent")}
                    </a>
                  </Button>
                </div>
              </div>
            </div>

            {/*
          A send box for every channel that has something to send (W2.2). It was
          `channel === "email"`, which meant a WhatsApp campaign could be created
          and then had no way to send anything — the screen offered a thing the
          product could not do.
        */}
          </div>

          {showSend ? (
            <form
              ref={formRef}
              action={(formData) => {
                setSummary(null);
                run(() => sendRequestsAction(formData), {
                  // The summary below counts what actually went out, which is
                  // the answer; "Sent" on top of it would be noise.
                  onSuccess: (result) => {
                    if (!result) return;
                    formRef.current?.reset();
                    setSummary(
                      t("sendResult", {
                        sent: result.sent,
                        failed: result.failed,
                        skipped: result.skipped,
                      }) +
                        (result.skippedNoAddress > 0
                          ? ` · ${t("sendSkippedNoAddress", { count: result.skippedNoAddress })}`
                          : "") +
                        (result.invalid.length > 0
                          ? ` — ${t("invalidAddresses", { list: result.invalid.join(", ") })}`
                          : ""),
                    );
                  },
                });
              }}
              /* A rule between the columns at `lg`, above them below it. */
              className="min-w-0 space-y-2 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8"
            >
              <input type="hidden" name="campaignId" value={campaign.id} />
              <RecipientPicker
                campaignId={campaign.id}
                channel={campaign.channel as "email" | "whatsapp" | "sms"}
                disabled={pending}
              />

              {summary ? <p className="text-body text-muted-foreground">{summary}</p> : null}

              <Button type="submit" size="sm" disabled={pending}>
                <Send className="size-4" aria-hidden />
                {pending ? t("sending") : t("send")}
              </Button>
            </form>
          ) : null}
        </div>

        {campaign.channel === "link" ? (
          <p className="border-t pt-4 text-body text-muted-foreground">{t("linkOnlyHint")}</p>
        ) : null}

        {canManage && !archived ? (
          <div>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                run(() => archiveCampaignAction({ campaignId: campaign.id }), {
                  success: tf("saved"),
                })
              }
            >
              <Archive className="size-4" aria-hidden />
              {pending ? t("archiving") : t("archive")}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
