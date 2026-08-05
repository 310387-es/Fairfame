"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SURVEY_TYPES, type SurveyType } from "@/surveys/scoring";
import { useAction } from "@/components/ui/use-action";
import { useCreateSheet } from "@/components/ds/create-sheet";
import { createSurveyAction, updateSurveyAction } from "@/server/surveys";

/**
 * The survey builder (P4-T2).
 *
 * One form for both templates, because NPS and CSAT differ in exactly two
 * things — the scale and the default question — and both are derived from
 * `type` rather than configured. A "builder" that let somebody set an NPS
 * range to 1–7 would produce a number nobody could compare with anything.
 *
 * **The review-invitation control is the compliance-relevant one.** It offers a
 * *collection campaign*, never a URL, and its help text says who sees it:
 * everyone. There is deliberately no "show this to happy customers" checkbox,
 * because that option is the prohibited pattern — and the code beneath cannot
 * express it, so the absence here is not the only thing preventing it.
 */

export type SurveyFormValues = {
  id?: string;
  name: string;
  type: SurveyType;
  locationId: string;
  locale: string | null;
  question: string | null;
  followUpEnabled: boolean;
  followUpPrompt: string | null;
  reviewCampaignId: string | null;
  status: "draft" | "active" | "archived";
};

const NONE = "__none__";

export function SurveyForm({
  initial,
  locations,
  campaigns,
}: {
  initial: SurveyFormValues;
  locations: { id: string; name: string }[];
  campaigns: { id: string; name: string }[];
}) {
  // Translated here, like every other authenticated screen: these render in the
  // reader's locale, which is the one `useTranslations` resolves.
  const t = useTranslations("surveys");
  const tf = useTranslations("feedback");
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const { close } = useCreateSheet();
  const { run, pending } = useAction();

  const editing = Boolean(initial.id);
  const set = <K extends keyof SurveyFormValues>(key: K, value: SurveyFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = () => {
    (() => {
      const payload = {
        name: values.name,
        locationId: values.locationId,
        locale: values.locale,
        question: values.question?.trim() ? values.question.trim() : null,
        followUpEnabled: values.followUpEnabled,
        followUpPrompt: values.followUpPrompt?.trim() ? values.followUpPrompt.trim() : null,
        reviewCampaignId: values.reviewCampaignId,
        status: values.status,
      };

      run(
        () =>
          initial.id
            ? updateSurveyAction({ ...payload, id: initial.id })
            : createSurveyAction({ ...payload, type: values.type }),
        {
          success: initial.id ? tf("saved") : tf("created"),
          onSuccess: (result) => {
            close();
            if (!initial.id && result && "id" in result && result.id) {
              router.push(`/surveys/${result.id}`);
              return;
            }
            router.refresh();
          },
        },
      );
    })();
  };

  return (
    <div className="flex flex-col gap-4 pb-(--card-py)">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="survey-name">{t("name")}</Label>
          <Input
            id="survey-name"
            value={values.name}
            maxLength={80}
            placeholder={t("namePlaceholder")}
            onChange={(event) => set("name", event.target.value)}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="survey-type">{t("type")}</Label>
          {/*
            Locked once the survey exists. Changing it would reinterpret every
            answer already collected — a stored 7 is a passive on NPS and off
            the scale entirely on CSAT — so the server does not accept the field
            at all and this only reflects that.
          */}
          <Select
            value={values.type}
            disabled={editing}
            onValueChange={(next) => set("type", next as SurveyType)}
          >
            <SelectTrigger id="survey-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SURVEY_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type === "nps" ? t("typeNps") : t("typeCsat")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {editing ? <p className="text-meta text-faint">{t("typeLocked")}</p> : null}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="survey-location">{t("location")}</Label>
          <Select value={values.locationId} onValueChange={(next) => set("locationId", next)}>
            <SelectTrigger id="survey-location">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {locations.map((location) => (
                <SelectItem key={location.id} value={location.id}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="survey-locale">{t("locale")}</Label>
          <Select
            value={values.locale ?? NONE}
            onValueChange={(next) => set("locale", next === NONE ? null : next)}
          >
            <SelectTrigger id="survey-locale">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t("localeAuto")}</SelectItem>
              <SelectItem value="tr">Türkçe</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="survey-question">{t("question")}</Label>
        <Textarea
          id="survey-question"
          value={values.question ?? ""}
          maxLength={280}
          rows={2}
          onChange={(event) => set("question", event.target.value)}
        />
        <p className="text-meta text-faint">{t("questionHint")}</p>
      </div>

      <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-sunken px-3 py-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="survey-follow-up"
            checked={values.followUpEnabled}
            onCheckedChange={(next) => set("followUpEnabled", next === true)}
          />
          <Label htmlFor="survey-follow-up">{t("followUp")}</Label>
        </div>
        <p className="text-meta text-faint">{t("followUpHint")}</p>

        {values.followUpEnabled ? (
          <div className="grid gap-1.5 pt-1">
            <Label htmlFor="survey-follow-up-prompt">{t("followUpPrompt")}</Label>
            <Textarea
              id="survey-follow-up-prompt"
              value={values.followUpPrompt ?? ""}
              maxLength={280}
              rows={2}
              onChange={(event) => set("followUpPrompt", event.target.value)}
            />
          </div>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="survey-campaign">{t("reviewCampaign")}</Label>
        <Select
          value={values.reviewCampaignId ?? NONE}
          onValueChange={(next) => set("reviewCampaignId", next === NONE ? null : next)}
        >
          <SelectTrigger id="survey-campaign">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t("reviewCampaignNone")}</SelectItem>
            {campaigns.map((campaign) => (
              <SelectItem key={campaign.id} value={campaign.id}>
                {campaign.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Says who sees it: everyone. That sentence is the product decision. */}
        <p className="text-meta text-faint">{t("reviewCampaignHint")}</p>
      </div>

      <div className="grid gap-1.5 sm:max-w-56">
        <Label htmlFor="survey-status">{t("status")}</Label>
        <Select
          value={values.status}
          onValueChange={(next) => set("status", next as SurveyFormValues["status"])}
        >
          <SelectTrigger id="survey-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="draft">{t("statusDraft")}</SelectItem>
            <SelectItem value="active">{t("statusActive")}</SelectItem>
            <SelectItem value="archived">{t("statusArchived")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Button onClick={submit} disabled={pending || !values.name.trim() || !values.locationId}>
          {pending ? t("saving") : editing ? t("save") : t("create")}
        </Button>
      </div>
    </div>
  );
}
