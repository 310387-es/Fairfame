"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { FieldError } from "@/components/ui/field-error";
import { useAction } from "@/components/ui/use-action";
import { useCreateSheet } from "@/components/ds/create-sheet";
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
  const tf = useTranslations("feedback");
  const [external, setExternal] = useState(false);
  const [emailChannel, setEmailChannel] = useState(true);
  const { close } = useCreateSheet();
  const { run, pending, fieldErrors, formRef, invalid } = useAction();

  return (
    <form
      ref={formRef}
      action={(formData) => {
        // Back to the empty string the action's schema expects. The sentinel
        // exists only because Radix cannot represent "" as an item.
        if (formData.get("locale") === LOCALE_DEFAULT) formData.set("locale", "");

        run(() => createCampaignAction(formData), {
          success: tf("created"),
          onSuccess: () => {
            formRef.current?.reset();
            setExternal(false);
            setEmailChannel(true);
            close();
          },
        });
      }}
      className="grid gap-4"
    >
      <div className="space-y-2">
        <Label htmlFor="campaign-name">{t("name")}</Label>
        <Input
          id="campaign-name"
          name="name"
          required
          maxLength={120}
          placeholder={t("namePlaceholder")}
          {...invalid("name")}
        />
        <FieldError name="name" message={fieldErrors.name} />
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
        <div className="space-y-2">
          <Label htmlFor="campaign-destination-url">{t("destinationUrl")}</Label>
          <Input
            id="campaign-destination-url"
            name="destinationUrl"
            type="url"
            required
            placeholder={t("destinationUrlPlaceholder")}
            {...invalid("destinationUrl")}
          />
          <FieldError name="destinationUrl" message={fieldErrors.destinationUrl} />
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
          <div className="space-y-2">
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

      <div>
        {/* No inline error block: the summary is a toast now, and the
                per-field messages sit under their own controls (W1.5). */}
        <Button type="submit" disabled={pending}>
          <Plus className="size-4" aria-hidden />
          {pending ? t("creating") : t("create")}
        </Button>
      </div>
    </form>
  );
}
