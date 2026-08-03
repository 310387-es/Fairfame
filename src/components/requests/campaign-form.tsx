"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { createCampaignAction } from "@/server/campaigns";
import type { LocationOption } from "@/lib/active-location";

/**
 * Creating a campaign.
 *
 * The form deliberately offers no "only ask happy customers" toggle, no rating
 * threshold, and no per-rating destination. Where the request goes is one
 * choice made here, once, for everyone.
 *
 * The selects are the system's `Select`, which renders a hidden native control
 * behind it — so these still submit through `FormData` and still restore on
 * `form.reset()` exactly as the native elements they replaced did.
 *
 * One sharp edge: Radix reserves the empty string for "no selection" and throws
 * on an item whose value is `""`. The language field's "use the default" option
 * therefore carries a sentinel, which is translated back on submit — see
 * `LOCALE_DEFAULT`.
 */

/** Stands in for "" on the language select, which Radix will not accept. */
const LOCALE_DEFAULT = "default";

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
        <CardTitle>{t("newCampaign")}</CardTitle>
        <CardDescription>{t("newCampaignDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          ref={formRef}
          action={(formData) => {
            setError(null);
            // Back to the empty string the action's schema expects. The sentinel
            // exists only because Radix cannot represent "" as an item.
            if (formData.get("locale") === LOCALE_DEFAULT) formData.set("locale", "");
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
            {/* Defaulted to the first location the way the native control did
                implicitly — with no default, a `required` Radix select shows a
                placeholder and submits nothing. */}
            <Select name="locationId" required defaultValue={locations[0]?.id}>
              <SelectTrigger id="campaign-location">
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

          <div className="space-y-2">
            <Label htmlFor="campaign-channel">{t("channel")}</Label>
            <Select
              name="channel"
              defaultValue="email"
              onValueChange={(next) => setEmailChannel(next === "email")}
            >
              <SelectTrigger id="campaign-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">{t("channelEmail")}</SelectItem>
                <SelectItem value="link">{t("channelLink")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="campaign-destination">{t("destination")}</Label>
            <Select
              name="destination"
              defaultValue="firstparty"
              onValueChange={(next) => setExternal(next === "external")}
            >
              <SelectTrigger id="campaign-destination">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="firstparty">{t("destinationFirstparty")}</SelectItem>
                <SelectItem value="external">{t("destinationExternal")}</SelectItem>
              </SelectContent>
            </Select>
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
            <Select name="locale" defaultValue={LOCALE_DEFAULT}>
              <SelectTrigger id="campaign-locale">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={LOCALE_DEFAULT}>{t("languageDefault")}</SelectItem>
                <SelectItem value="tr">Türkçe</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectContent>
            </Select>
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
              <p role="alert" className="mb-3 text-body text-destructive">
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
