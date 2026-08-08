"use client";

import { Archive, Check, Copy, Download, ExternalLink, Printer, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Eyebrow } from "@/components/ds/eyebrow";
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

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* The one place 17px is genuinely right: a card's own title, above
                `title` and well below `metric`. It named no size at all before. */}
            <p className="truncate text-[17px] font-semibold">{campaign.name}</p>
            <p className="truncate text-body text-muted-foreground">
              {campaign.locationName} ·{" "}
              {campaign.channel === "email" ? t("channelEmail") : t("channelLink")}
            </p>
          </div>
          {/* Active is a state, not a control — the positive pair, not indigo. */}
          <Badge variant={archived ? "secondary" : "positive"}>
            {archived ? t("statusArchived") : t("statusActive")}
          </Badge>
        </div>

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

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={copyLink}>
                {copied ? (
                  <Check className="size-4" aria-hidden />
                ) : (
                  <Copy className="size-4" aria-hidden />
                )}
                {copied ? t("copied") : t("copy")}
              </Button>
              <Button asChild size="sm" variant="ghost">
                <a href={`/api/campaigns/${campaign.id}/qr`} download>
                  <Download className="size-4" aria-hidden />
                  {t("downloadQr")}
                </a>
              </Button>

              {/*
                The poster and the table tent (W4.5).

                Plain links with `download`, like the QR image beside them: the
                browser knows how to save a response with a
                `Content-Disposition`, and the alternative is holding a PDF in
                memory and minting an object URL for no gain. Two links rather
                than a menu — there are two, and a dropdown to choose between
                two things is a click spent on nothing.
              */}
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
              <Button asChild size="sm" variant="ghost">
                <a href={campaign.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" aria-hidden />
                  {t("openPage")}
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
        {campaign.channel !== "link" && canManage && !archived ? (
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
            className="space-y-2 border-t pt-4"
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
