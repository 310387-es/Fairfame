"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAction } from "@/components/ui/use-action";
import { useCreateSheet } from "@/components/ds/create-sheet";
import { audienceSizeAction, createBroadcastAction } from "@/server/broadcasts";

/**
 * Building a broadcast (P4-T4).
 *
 * Four questions in the order somebody actually answers them: **what** is being
 * sent, **to whom**, **on what channel**, and **when**.
 *
 * The channel is derived from the kind rather than chosen freely, because three
 * of the nine combinations are the only ones that exist — review requests and
 * surveys go by email, a template message goes on WhatsApp or SMS. Offering the
 * other six and refusing them on save would be a form that lets you be wrong
 * and then tells you off.
 *
 * **The audience count is live, and it is the count that will actually be
 * sent.** It resolves under the caller's own location scope, the same one the
 * send uses, so a branch manager sees the number they can reach rather than an
 * organization-wide figure that would shrink at send time.
 */

export type BroadcastFormOption = { id: string; name: string };

type Kind = "review_request" | "survey" | "message";

/**
 * The channels each kind can actually go out on.
 *
 * Review requests gained WhatsApp and SMS in W2.2, when they learned to route
 * through `sendMessage` and the consent gate. Email leads because it is the one
 * that reaches somebody the business does not already hold a permission for —
 * the others are refused per recipient, by the gate, with a reason.
 *
 * Surveys are still email-only: nothing has taught `prepareInvites` to address
 * a contact by phone, and offering a channel the send would refuse for a reason
 * that is not about the *customer* would be a control that lies.
 */
const CHANNELS: Record<Kind, ("email" | "sms" | "whatsapp")[]> = {
  review_request: ["email", "whatsapp", "sms"],
  survey: ["email"],
  message: ["whatsapp", "sms"],
};

export function BroadcastForm({
  segments,
  campaigns,
  surveys,
  templates,
}: {
  segments: BroadcastFormOption[];
  campaigns: BroadcastFormOption[];
  surveys: BroadcastFormOption[];
  templates: { name: string; variables: string[] }[];
}) {
  const t = useTranslations("broadcasts");
  const tf = useTranslations("feedback");
  const router = useRouter();

  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("review_request");
  const [picked, setPicked] = useState<"email" | "sms" | "whatsapp">("email");
  const [segmentId, setSegmentId] = useState(segments[0]?.id ?? "");
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "");
  const [surveyId, setSurveyId] = useState(surveys[0]?.id ?? "");
  const [templateName, setTemplateName] = useState(templates[0]?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [scheduledAt, setScheduledAt] = useState("");
  const [fetchedSize, setFetchedSize] = useState<number | null>(null);
  const { close } = useCreateSheet();
  const { run, pending } = useAction();

  /**
   * The channel that will actually be used — **derived, not synchronised.**
   *
   * An earlier version kept it in state and corrected it from an effect when
   * the kind changed, which is a cascading render and which React's own lint
   * rule refuses. Deriving it means the illegal combination never exists for a
   * frame, rather than existing and being fixed.
   */
  const allowed = CHANNELS[kind];
  const channel = allowed.includes(picked) ? picked : allowed[0]!;

  useEffect(() => {
    if (!segmentId) return;

    let cancelled = false;
    void audienceSizeAction({ segmentId, channel }).then((result) => {
      // The request that started last is the only one whose answer matters —
      // without this, switching channel twice quickly can leave the first
      // reply on screen under the second selection.
      if (!cancelled) setFetchedSize(result.ok ? (result.size ?? 0) : null);
    });

    return () => {
      cancelled = true;
    };
  }, [segmentId, channel]);

  // Derived for the same reason: no segment means no number, and clearing it
  // from an effect would be a second render to say what this already says.
  const size = segmentId ? fetchedSize : null;

  const channelLabel = {
    email: t("channelEmail"),
    sms: t("channelSms"),
    whatsapp: t("channelWhatsapp"),
  } as const;

  const selectedTemplate = templates.find((entry) => entry.name === templateName);

  const submit = () => {
    run(
      () =>
        createBroadcastAction({
          name,
          kind,
          channel,
          segmentId,
          campaignId: kind === "review_request" ? campaignId : null,
          surveyId: kind === "survey" ? surveyId : null,
          templateName: kind === "message" ? templateName : null,
          templateValues:
            kind === "message"
              ? (selectedTemplate?.variables ?? []).map((variable) => values[variable] ?? "")
              : [],
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        }),
      {
        success: tf("created"),
        onSuccess: (result) => {
          close();
          if (result && "id" in result && result.id) router.push(`/broadcasts/${result.id}`);
        },
      },
    );
  };

  const missingPayload =
    (kind === "review_request" && !campaignId) ||
    (kind === "survey" && !surveyId) ||
    (kind === "message" && !templateName);

  return (
    <div className="flex flex-col gap-4 pb-(--card-py)">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="broadcast-name">{t("name")}</Label>
          <Input
            id="broadcast-name"
            value={name}
            maxLength={120}
            placeholder={t("namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="broadcast-kind">{t("what")}</Label>
          <Select value={kind} onValueChange={(next) => setKind(next as Kind)}>
            <SelectTrigger id="broadcast-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="review_request">{t("kindReviewRequest")}</SelectItem>
              <SelectItem value="survey">{t("kindSurvey")}</SelectItem>
              <SelectItem value="message">{t("kindMessage")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="broadcast-segment">{t("audience")}</Label>
          <Select value={segmentId} onValueChange={setSegmentId}>
            <SelectTrigger id="broadcast-segment">
              <SelectValue placeholder={t("noSegments")} />
            </SelectTrigger>
            <SelectContent>
              {segments.map((segment) => (
                <SelectItem key={segment.id} value={segment.id}>
                  {segment.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-meta text-faint">
            {size === null ? t("audienceUnknown") : t("audienceSize", { count: size })}
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="broadcast-channel">{t("channel")}</Label>
          <Select
            value={channel}
            disabled={allowed.length === 1}
            onValueChange={(next) => setPicked(next as "email" | "sms" | "whatsapp")}
          >
            <SelectTrigger id="broadcast-channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allowed.map((option) => (
                <SelectItem key={option} value={option}>
                  {channelLabel[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {kind === "review_request" ? (
        <div className="grid gap-1.5">
          <Label htmlFor="broadcast-campaign">{t("campaign")}</Label>
          <Select value={campaignId} onValueChange={setCampaignId}>
            <SelectTrigger id="broadcast-campaign">
              <SelectValue placeholder={t("noCampaigns")} />
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
      ) : null}

      {kind === "survey" ? (
        <div className="grid gap-1.5">
          <Label htmlFor="broadcast-survey">{t("survey")}</Label>
          <Select value={surveyId} onValueChange={setSurveyId}>
            <SelectTrigger id="broadcast-survey">
              <SelectValue placeholder={t("noSurveys")} />
            </SelectTrigger>
            <SelectContent>
              {surveys.map((survey) => (
                <SelectItem key={survey.id} value={survey.id}>
                  {survey.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {kind === "message" ? (
        <div className="flex flex-col gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="broadcast-template">{t("template")}</Label>
            <Select value={templateName} onValueChange={setTemplateName}>
              <SelectTrigger id="broadcast-template">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {templates.map((entry) => (
                  <SelectItem key={entry.name} value={entry.name}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {(selectedTemplate?.variables ?? []).map((variable) => (
            <div key={variable} className="grid gap-1.5">
              <Label htmlFor={`var-${variable}`}>{variable}</Label>
              <Input
                id={`var-${variable}`}
                maxLength={500}
                value={values[variable] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [variable]: event.target.value }))
                }
              />
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-1.5 sm:max-w-72">
        <Label htmlFor="broadcast-when">{t("when")}</Label>
        <Input
          id="broadcast-when"
          type="datetime-local"
          value={scheduledAt}
          onChange={(event) => setScheduledAt(event.target.value)}
        />
        <p className="text-meta text-faint">{t("whenHint")}</p>
      </div>

      {/*
        The compliance line, before the button rather than after the send. Every
        recipient is checked individually and a refusal is reported by name —
        which means the number above is an upper bound, not a promise.
      */}
      <p className="text-meta text-faint">{t("consentNote")}</p>

      <div>
        <Button onClick={submit} disabled={pending || !name.trim() || !segmentId || missingPayload}>
          {pending ? t("creating") : scheduledAt ? t("schedule") : t("createDraft")}
        </Button>
      </div>
    </div>
  );
}
