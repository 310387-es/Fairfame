import { getTranslations } from "next-intl/server";
import { cn } from "@/lib/utils";

/**
 * What still stands between a provider and going live, in the reader's language
 * (W4.2).
 *
 * `ProviderDescriptor.goLiveNote` is a sentence written for whoever is wiring
 * the connector, in English, and it has been rendered untranslated on the
 * Locations screen since P1b. That was survivable while it sat on a card most
 * customers never opened; Connections puts it under a source's health, on the
 * one screen a Turkish owner visits to find out why nothing is arriving, and a
 * sentence they cannot read is worse than no sentence at all.
 *
 * So the catalogue keeps its English note as the **fallback**, and the message
 * catalogue carries the translation. The fallback matters: a provider added
 * later gets its descriptor note rendered rather than a raw key or nothing,
 * which is the failure mode a strict lookup would produce on exactly the screen
 * where somebody is trying to work out what is wrong.
 */
export async function GoLiveNote({
  provider,
  fallback,
  className,
}: {
  provider: string;
  fallback: string | null;
  className?: string;
}) {
  const t = await getTranslations("connections");
  const key = `goLive.${provider}`;

  const text = t.has(key) ? t(key) : fallback;
  if (text === null || text === "") return null;

  return <p className={cn("text-meta text-ink-500", className)}>{text}</p>;
}
