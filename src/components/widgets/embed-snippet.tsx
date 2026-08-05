"use client";

import { Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { segmentedItem, segmentedTrough } from "@/components/ds/segmented";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isBadgeLayout, type WidgetStyle } from "@/widgets/config";

/**
 * The two lines a customer pastes into their own site.
 *
 * Both are offered, because they are not the same trade. The **script** mounts
 * the widget and keeps its height in step with its content, which is what
 * almost everyone wants. The **iframe** needs no JavaScript at all and survives
 * a strict `script-src` on the host page, at the cost of a height the customer
 * has to pick. They render identically — the script's whole job is to mount the
 * iframe — so choosing between them is about the host page, not about the
 * widget.
 *
 * Local state, Radix-free: this is "which of two things already on the page am
 * I looking at", which the design system puts in local state rather than the
 * URL.
 */
type Flavour = "script" | "iframe";

/**
 * First-paint sizes, in pixels — a guess, and only ever a guess.
 *
 * The script's frame replaces them with its own measurement within a tick, so
 * their whole job is to make the moment before that unremarkable: the loader's
 * 420px default is right for a wall of reviews and is a visible flash of
 * nothing above a badge. The plain-iframe snippet has no script to correct it,
 * so there the number the customer pastes is the number they keep — which is
 * why the badge one is generous rather than exact, and why it stays full-width:
 * a badge clipped by a too-tight box is worse than one with room to spare.
 */
const BADGE_HEIGHT = 64;
const WALL_HEIGHT = 520;

export function EmbedSnippet({
  publicKey,
  origin,
  published,
  widgetName,
  layout,
}: {
  publicKey: string;
  origin: string;
  published: boolean;
  widgetName: string;
  layout: WidgetStyle["layout"];
}) {
  const t = useTranslations("widgets");
  const [flavour, setFlavour] = useState<Flavour>("script");
  const [copied, setCopied] = useState(false);

  const height = isBadgeLayout(layout) ? BADGE_HEIGHT : WALL_HEIGHT;

  const snippet =
    flavour === "script"
      ? `<script src="${origin}/embed/widget.js" data-revira-widget="${publicKey}"${isBadgeLayout(layout) ? ` data-revira-height="${BADGE_HEIGHT}"` : ""}></script>`
      : `<iframe src="${origin}/embed/w/${publicKey}" title="${widgetName.replace(/"/g, "&quot;")}"\n        style="width:100%;height:${height}px;border:0;display:block"></iframe>`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused outright (an insecure origin, a locked
      // down browser). The snippet is on screen and selectable, so the fallback
      // is to say nothing and let the reader copy it by hand — a thrown error
      // in a toast would be noise about a thing they can already do.
    }
  };

  return (
    <div className="flex flex-col gap-3 pb-(--card-py)">
      {!published ? <p className="text-body text-ink-400">{t("snippetDraft")}</p> : null}

      <div className={cn(segmentedTrough("sm"), "self-start")} role="group">
        {(["script", "iframe"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={flavour === option}
            className={segmentedItem("sm", flavour === option)}
            onClick={() => setFlavour(option)}
          >
            {t(`snippet.${option}`)}
          </button>
        ))}
      </div>

      <p className="text-meta text-faint">{t(`snippetHint.${flavour}`)}</p>

      {/* Selectable, wrapping, and never an input: this is code to read and
          copy, not a field to edit. */}
      <pre className="overflow-x-auto rounded-md border border-line bg-surface-sunken p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
        <code>{snippet}</code>
      </pre>

      <Button type="button" variant="outline" onClick={copy} className="self-start">
        <Copy className="size-4" aria-hidden />
        {copied ? t("copied") : t("copy")}
      </Button>

      {/* Announced when it changes, so a screen-reader user learns the copy
          worked — the button label alone changes silently. */}
      <span aria-live="polite" className="sr-only">
        {copied ? t("copied") : ""}
      </span>
    </div>
  );
}
