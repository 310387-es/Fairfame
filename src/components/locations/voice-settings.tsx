"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAction } from "@/components/ui/use-action";
import { MAX_BRAND_TONE_CHARS } from "@/prompts/index";
import { MAX_SIGNATURE_CHARS } from "@/replies/style";
import { setLocationVoiceAction } from "@/server/locations";

/**
 * How this branch's replies sound and how they sign off (W5-12).
 *
 * `brand_tone` is not new — it has been in the draft prompt since P1a-T6 and
 * has never had a control, which meant every business in the product got the
 * neutral default whether it suited them or not. A field the code reads and no
 * screen writes is indistinguishable from a missing feature.
 *
 * Both live on the branch, not the organization, because a chain's flagship and
 * its airport kiosk are answered by different people in different words — the
 * same argument the schema comment makes.
 *
 * The signature is a plain input rather than a textarea on purpose: it is a
 * name and a role, and a multi-line box invites the opening hours and a
 * discount code that then go out on the end of an apology.
 */
export function VoiceSettings({
  locationId,
  brandTone,
  replySignature,
  canManage,
}: {
  locationId: string;
  brandTone: string | null;
  replySignature: string | null;
  canManage: boolean;
}) {
  const t = useTranslations("locations");
  const { run, pending } = useAction();
  const [tone, setTone] = useState(brandTone ?? "");
  const [signature, setSignature] = useState(replySignature ?? "");

  const dirty = tone !== (brandTone ?? "") || signature !== (replySignature ?? "");

  if (!canManage) {
    // A member sees what the branch sounds like — it explains the drafts they
    // are editing — without a control the server would refuse.
    if (!brandTone && !replySignature) return null;
    return (
      <div className="border-t border-line pt-4">
        <p className="text-copy text-muted-foreground">
          {brandTone ? t("voice.toneIs", { tone: brandTone }) : t("voice.toneUnset")}
        </p>
        {replySignature ? (
          <p className="mt-1 text-copy whitespace-pre-line text-muted-foreground">
            {replySignature}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div>
        <h3 className="text-title">{t("voice.heading")}</h3>
        <p className="text-copy text-muted-foreground">{t("voice.description")}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`tone-${locationId}`}>{t("voice.toneLabel")}</Label>
        <Textarea
          id={`tone-${locationId}`}
          value={tone}
          rows={2}
          maxLength={MAX_BRAND_TONE_CHARS}
          placeholder={t("voice.tonePlaceholder")}
          onChange={(event) => setTone(event.target.value)}
          disabled={pending}
        />
        <p className="text-copy text-muted-foreground">{t("voice.toneHelp")}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`signature-${locationId}`}>{t("voice.signatureLabel")}</Label>
        <Input
          id={`signature-${locationId}`}
          value={signature}
          maxLength={MAX_SIGNATURE_CHARS}
          placeholder={t("voice.signaturePlaceholder")}
          onChange={(event) => setSignature(event.target.value)}
          disabled={pending}
        />
        <p className="text-copy text-muted-foreground">{t("voice.signatureHelp")}</p>
      </div>

      <div>
        <Button
          type="button"
          size="sm"
          disabled={pending || !dirty}
          onClick={() =>
            run(() =>
              setLocationVoiceAction({ locationId, brandTone: tone, replySignature: signature }),
            )
          }
        >
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t("voice.save")}
        </Button>
      </div>
    </div>
  );
}
