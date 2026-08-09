"use client";

import { Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAction } from "@/components/ui/use-action";
import { sendRequestsAction } from "@/server/campaigns";

/**
 * Asking this one person for a review (W2.2).
 *
 * `docs/remediation-plan.md` asks for "a 'Send a request' button on every
 * contact", and the reason it belongs here rather than only on `/get-reviews` is
 * the errand: somebody looking at a customer's profile — having just read their
 * complaint, or seen they have been in four times — wants to ask *them*, not to
 * go and assemble an audience.
 *
 * **It goes through the same action as a bulk send**, with an audience of one.
 * A second path would be a second place for the opt-out check, the metering and
 * the consent gate to be applied slightly differently, and the one that got it
 * wrong would be this one — the quiet path nobody tests.
 *
 * The campaign is chosen rather than assumed, because a campaign carries the
 * destination: asking somebody to review on Google and asking them to fill in
 * the hosted form are different requests, and picking one for the reader would
 * be picking where their customer's words end up.
 */
export function SendRequest({
  contactId,
  campaigns,
}: {
  contactId: string;
  campaigns: { id: string; name: string }[];
}) {
  const t = useTranslations("contacts");
  // The refusal vocabulary and the skip reasons, borrowed rather than copied —
  // see `campaign-card.tsx`: one union, one set of words.
  const tRefusal = useTranslations("messages");
  const tRequests = useTranslations("requests");
  const { run, pending } = useAction();
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "");
  const [summary, setSummary] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  if (campaigns.length === 0) {
    // No campaign, nothing to send under. Said plainly rather than shown as a
    // disabled button, which tells somebody they are not allowed rather than
    // that there is a thing to go and make first.
    return <p className="text-body text-ink-400">{t("sendNoCampaign")}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`send-campaign-${contactId}`}>{t("sendCampaign")}</Label>
        <Select value={campaignId} onValueChange={setCampaignId} disabled={pending}>
          <SelectTrigger id={`send-campaign-${contactId}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {campaigns.map((campaign) => (
              <SelectItem key={campaign.id} value={campaign.id}>
                {campaign.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button
        type="button"
        size="sm"
        className="self-start"
        disabled={pending || campaignId === ""}
        onClick={() => {
          const formData = new FormData();
          formData.set("campaignId", campaignId);
          formData.set("contactIds", contactId);

          setSummary(null);
          setReason(null);
          void run(() => sendRequestsAction(formData), {
            onSuccess: (result) => {
              if (!result) return;
              // The counts, not "Sent" — an audience of one can still be
              // skipped for an opt-out or a missing address, and "Sent"
              // over a skip is the lie this reports instead.
              setSummary(
                t("sendOutcome", {
                  sent: result.sent,
                  failed: result.failed,
                  skipped: result.skipped + result.skippedNoAddress,
                }),
              );

              /**
               * And **why**, which the counts cannot say (A22-B3).
               *
               * An audience of one makes this sharper than the bulk screen, not
               * softer: "0 sent · 1 failed" about a named person the reader is
               * looking at is a screen that knows the answer and will not give
               * it. A refusal carries a code, so it is said in their language; a
               * transport error carries only the provider's own sentence, and
               * inventing a translation for it would be putting words in
               * somebody else's mouth.
               */
              const failure = result.failures[0];
              const skipped = result.skippedDetail[0];

              setReason(
                failure
                  ? failure.refusal
                    ? tRefusal(`refusal.${failure.refusal}`)
                    : failure.reason
                  : skipped
                    ? tRequests(`skipReason.${skipped.reason}`)
                    : null,
              );
            },
          });
        }}
      >
        <Send className="size-4" aria-hidden />
        {pending ? t("sending") : t("sendRequest")}
      </Button>

      {summary ? <p className="text-body text-muted-foreground">{summary}</p> : null}
      {reason ? <p className="text-copy text-muted-foreground">{reason}</p> : null}
    </div>
  );
}
