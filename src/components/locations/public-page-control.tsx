"use client";

import { Check, Copy, ExternalLink, Globe } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { setPublicPageAction } from "@/server/locations";
import { locationPageUrl } from "@/seo/urls";

/**
 * Publishing a location's hosted review page (P3-T3).
 *
 * On the location card rather than in Showcase, because the thing being
 * published is *the location* — one page per branch, addressed by the branch's
 * own name, and the only decision is whether it is live. A widget is something
 * you configure; this is something you turn on.
 *
 * The copy tells the truth about two things a toggle cannot: that the page is
 * indexable by search engines, and that it shows only what has already been
 * approved for display. The second matters because approval happens on a
 * different screen — a business that publishes here and sees an empty page
 * would otherwise have no idea why.
 */
export function PublicPageControl({
  locationId,
  slug,
  published,
  origin,
  approvedCount,
  canManage,
}: {
  locationId: string;
  /** Null until the page has been published once — the slug is minted then. */
  slug: string | null;
  published: boolean;
  /** The origin a visitor will hit, resolved on the server. */
  origin: string;
  /** How many reviews this organization has approved for display, anywhere. */
  approvedCount: number;
  canManage: boolean;
}) {
  const t = useTranslations("locations");
  const [state, setState] = useState({ slug, published });
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const url = state.slug ? locationPageUrl(origin, state.slug) : null;

  const toggle = () => {
    setError(null);
    startTransition(async () => {
      const result = await setPublicPageAction({ locationId, published: !state.published });
      if (result.ok) setState({ slug: result.slug ?? state.slug, published: !state.published });
      else setError(result.error);
    });
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Refused clipboard access (an insecure origin, a locked-down browser).
      // The URL is on screen and selectable, so the fallback is to say nothing.
    }
  };

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-title">
          <Globe className="size-4 text-muted-foreground" aria-hidden />
          {t("publicPageLabel")}
        </span>
        <Badge variant={state.published ? "positive" : "secondary"}>
          {state.published ? t("publicPageLive") : t("publicPageDraft")}
        </Badge>
      </div>

      <p className="text-copy text-muted-foreground">{t("publicPageHint")}</p>

      {/* Said before publishing, not after: an empty page is the one outcome a
          business cannot diagnose from the page itself. */}
      {approvedCount === 0 ? (
        <p className="text-copy text-muted-foreground">{t("publicPageNothingApproved")}</p>
      ) : null}

      {url && state.published ? (
        <p className="rounded-md border border-line bg-surface-sunken px-3 py-2 font-mono text-[11.5px] break-all">
          {url}
        </p>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={state.published ? "outline" : "default"}
            onClick={toggle}
            disabled={pending}
          >
            {state.published ? t("publicPageUnpublish") : t("publicPagePublish")}
          </Button>

          {url && state.published ? (
            <>
              <Button type="button" size="sm" variant="outline" onClick={copy}>
                {copied ? (
                  <Check className="size-4" aria-hidden />
                ) : (
                  <Copy className="size-4" aria-hidden />
                )}
                {copied ? t("publicPageCopied") : t("publicPageCopy")}
              </Button>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-sm text-copy text-primary underline-offset-2 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {t("publicPageOpen")}
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-copy text-destructive">
          {error}
        </p>
      ) : null}

      {/* Announced when it changes, so a screen-reader user learns the copy
          worked — the button label alone changes silently. */}
      <span aria-live="polite" className="sr-only">
        {copied ? t("publicPageCopied") : ""}
      </span>
    </div>
  );
}
