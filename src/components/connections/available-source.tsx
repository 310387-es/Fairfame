"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ProviderMark } from "@/components/connections/provider-mark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAction } from "@/components/ui/use-action";
import type { AvailableSourceCard } from "@/connections/facts";
import { connectSourceAction } from "@/server/locations";

/**
 * A source this deployment could connect, and the branch question (W4.2).
 *
 * **Connecting needs a location, and this screen is not organised by location.**
 * `connections.location_id` is NOT NULL because a Google listing belongs to a
 * branch, not to a business — that is correct and is not changing. So the card
 * has to ask, and the interesting case is the common one: a business with a
 * single branch has nothing to ask about, so the picker does not appear at all
 * and the button connects. Asking a one-branch café to choose from a list of
 * one is a question with no information in it.
 *
 * A business with no locations yet cannot connect anything, and says so with
 * the thing to do rather than a disabled button (W1.7).
 */

/**
 * The go-live sentence, translated where we have one (W4.2).
 *
 * The same rule as `go-live-note.tsx`, which is the server half: the
 * descriptor's English note is the *fallback*, so a provider added later says
 * something a developer wrote rather than nothing at all. Duplicated rather
 * than shared because this side is a client component and that one reads
 * `getTranslations` — one line of logic in two places is cheaper than a
 * client/server seam over a string lookup.
 */
function goLive(
  t: ReturnType<typeof useTranslations<"connections">>,
  provider: string,
  fallback: string | null,
): string {
  const key = `goLive.${provider}`;
  if (t.has(key)) return t(key);
  return fallback ?? t("willAuthorize");
}

export function AvailableSource({
  card,
  locations,
  canManage,
}: {
  card: AvailableSourceCard;
  locations: { id: string; name: string }[];
  canManage: boolean;
}) {
  const t = useTranslations("connections");
  const { run, pending } = useAction();
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");

  const connect = () => {
    if (locationId === "") return;
    run(() => connectSourceAction({ locationId, provider: card.provider }), {
      success: t("connected", { label: card.label }),
    });
  };

  return (
    <Card className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <ProviderMark provider={card.provider} size={28} />
        <h3 className="min-w-0 flex-1 truncate text-copy font-semibold text-foreground">
          {card.label}
        </h3>
      </div>

      {/*
        What connecting will actually get you, said before you press. `isMock`
        means the provider is on fixtures — the connection will work, sync and
        show reviews, and none of them will be real. Somebody finding that out
        afterwards is somebody who no longer trusts any number on the screen.
      */}
      <p className="text-meta text-ink-500">
        {card.isMock ? t("willUseDemoData") : goLive(t, card.provider, card.goLiveNote)}
      </p>

      {canManage ? (
        locations.length === 0 ? (
          <p className="mt-auto text-meta text-ink-500">{t("needsLocationFirst")}</p>
        ) : (
          <div className="mt-auto flex flex-col gap-2">
            {locations.length > 1 ? (
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger aria-label={t("chooseBranch")} className="w-full">
                  <SelectValue placeholder={t("chooseBranch")} />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((location) => (
                    <SelectItem key={location.id} value={location.id}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            <Button size="sm" onClick={connect} disabled={pending}>
              {card.canAuthorize ? t("connect") : t("connectDemo")}
            </Button>
          </div>
        )
      ) : null}
    </Card>
  );
}
