"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createCampaignAction } from "@/server/campaigns";
import type { LocationOption } from "@/lib/active-location";

/**
 * Creating a campaign.
 *
 * The form deliberately offers no "only ask happy customers" toggle, no rating
 * threshold, and no per-rating destination. Where the request goes is one
 * choice made here, once, for everyone.
 *
 * Native `<select>` rather than a styled listbox: the project has no select
 * primitive yet, and the native control is accessible, keyboard-complete and
 * better on mobile than anything worth hand-rolling for four options.
 */

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

export function CampaignForm({ locations }: { locations: LocationOption[] }) {
  const t = useTranslations("requests");
  const [error, setError] = useState<string | null>(null);
  const [external, setExternal] = useState(false);
  const [emailChannel, setEmailChannel] = useState(true);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("newCampaign")}</CardTitle>
        <CardDescription>{t("newCampaignDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          ref={formRef}
          action={(formData) => {
            setError(null);
            startTransition(async () => {
              const result = await createCampaignAction(formData);
              if (result.ok) {
                formRef.current?.reset();
                setExternal(false);
                setEmailChannel(true);
              } else {
                setError(result.error);
              }
            });
          }}
          className="grid gap-4 sm:grid-cols-2"
        >
          <div className="space-y-2">
            <Label htmlFor="campaign-name">{t("name")}</Label>
            <Input
              id="campaign-name"
              name="name"
              required
              maxLength={120}
              placeholder={t("namePlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="campaign-location">{t("location")}</Label>
            <select id="campaign-location" name="locationId" required className={SELECT_CLASS}>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="campaign-channel">{t("channel")}</Label>
            <select
              id="campaign-channel"
              name="channel"
              defaultValue="email"
              onChange={(event) => setEmailChannel(event.target.value === "email")}
              className={SELECT_CLASS}
            >
              <option value="email">{t("channelEmail")}</option>
              <option value="link">{t("channelLink")}</option>
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="campaign-destination">{t("destination")}</Label>
            <select
              id="campaign-destination"
              name="destination"
              defaultValue="firstparty"
              onChange={(event) => setExternal(event.target.value === "external")}
              className={SELECT_CLASS}
            >
              <option value="firstparty">{t("destinationFirstparty")}</option>
              <option value="external">{t("destinationExternal")}</option>
            </select>
          </div>

          {external ? (
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="campaign-destination-url">{t("destinationUrl")}</Label>
              <Input
                id="campaign-destination-url"
                name="destinationUrl"
                type="url"
                required
                placeholder={t("destinationUrlPlaceholder")}
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="campaign-locale">{t("language")}</Label>
            <select id="campaign-locale" name="locale" defaultValue="" className={SELECT_CLASS}>
              <option value="">{t("languageDefault")}</option>
              <option value="tr">Türkçe</option>
              <option value="en">English</option>
            </select>
          </div>

          {/* Copy overrides only make sense for a channel that sends something. */}
          {emailChannel ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="campaign-subject">{t("subject")}</Label>
                <Input
                  id="campaign-subject"
                  name="subject"
                  maxLength={200}
                  placeholder={t("subjectPlaceholder")}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="campaign-body">{t("body")}</Label>
                <Textarea
                  id="campaign-body"
                  name="body"
                  maxLength={2000}
                  placeholder={t("bodyPlaceholder")}
                />
              </div>
            </>
          ) : null}

          <div className="sm:col-span-2">
            {error ? (
              <p role="alert" className="mb-3 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={pending}>
              <Plus className="size-4" aria-hidden />
              {pending ? t("creating") : t("create")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
