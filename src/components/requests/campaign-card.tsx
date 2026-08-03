"use client";

import { Archive, Check, Copy, Download, ExternalLink, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MAX_RECIPIENTS_PER_SEND } from "@/collect/input";
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
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  const archived = campaign.status === "archived";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(campaign.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be denied; the link is on screen either way.
      setError(null);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{campaign.name}</p>
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

        {/* A three-cell funnel. Micro-caps labels and mono numerals, so it reads
            as the same kind of thing as the KPI strip on Home rather than as a
            grey box that happens to contain numbers. */}
        <dl className="grid grid-cols-3 gap-2 rounded-md bg-surface-sunken p-3 text-center">
          {(
            [
              ["funnelSent", campaign.funnel.sent],
              ["funnelOpened", campaign.funnel.opened],
              ["funnelSubmitted", campaign.funnel.submitted],
            ] as const
          ).map(([key, value]) => (
            <div key={key}>
              <dt className="text-eyebrow text-faint uppercase">{t(key)}</dt>
              <dd className="mt-1 font-mono text-[17px] font-semibold tabular-nums">{value}</dd>
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
            <code className="truncate rounded-md bg-muted px-2 py-1 text-copy">{campaign.url}</code>

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
              <Button asChild size="sm" variant="ghost">
                <a href={campaign.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" aria-hidden />
                  {t("openPage")}
                </a>
              </Button>
            </div>
          </div>
        </div>

        {campaign.channel === "email" && canManage && !archived ? (
          <form
            ref={formRef}
            action={(formData) => {
              setError(null);
              setSummary(null);
              startTransition(async () => {
                const result = await sendRequestsAction(formData);
                if (!result.ok) {
                  setError(result.error);
                  return;
                }

                formRef.current?.reset();
                setSummary(
                  t("sendResult", {
                    sent: result.sent,
                    failed: result.failed,
                    skipped: result.skipped,
                  }) +
                    (result.invalid.length > 0
                      ? ` — ${t("invalidAddresses", { list: result.invalid.join(", ") })}`
                      : ""),
                );
              });
            }}
            className="space-y-2 border-t pt-4"
          >
            <input type="hidden" name="campaignId" value={campaign.id} />
            <Label htmlFor={`recipients-${campaign.id}`}>{t("recipients")}</Label>
            <Textarea
              id={`recipients-${campaign.id}`}
              name="recipients"
              required
              placeholder={t("recipientsPlaceholder")}
            />
            <p className="text-copy text-muted-foreground">
              {t("recipientsHint", { max: MAX_RECIPIENTS_PER_SEND })}
            </p>

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

        {error ? (
          <p role="alert" className="text-body text-destructive">
            {error}
          </p>
        ) : null}

        {canManage && !archived ? (
          <div>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await archiveCampaignAction({ campaignId: campaign.id });
                  if (!result.ok) setError(result.error);
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
