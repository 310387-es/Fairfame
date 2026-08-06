import { Download } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { CopyButton } from "@/components/digest/copy-button";
import { Button } from "@/components/ui/button";

/**
 * Taking the week somewhere else (W2.1).
 *
 * Two ways out, because they are two different errands rather than a format
 * choice:
 *
 *   - **PDF** for a briefing that has to survive being printed, pinned up, or
 *     handed to a branch manager who has no login.
 *   - **Copy as text** for WhatsApp, which is how a Turkish SMB owner actually
 *     forwards anything. It is the reason this is not a lone download button.
 *
 * **Neither is a link to this page**, deliberately. `/weekly-plan/{id}` needs a
 * session, so "copy link" would send anybody outside the team to a sign-in
 * screen — a share that lands on a login form is worse than no share at all. A
 * genuinely public digest is a different feature with a different threat model
 * (the public surface rules in `CLAUDE.md`), and inventing a token here would
 * be the wrong place to decide it.
 *
 * The download is a plain `<a>` rather than a fetch: the browser already knows
 * how to save a file the server has named, and doing it by hand means owning
 * the blob, the object URL and its revocation for no gain.
 */
export async function DigestShare({
  digestId,
  shareText,
}: {
  digestId: string;
  shareText: string;
}) {
  const t = await getTranslations("digest");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild variant="outline" size="sm">
        <a href={`/weekly-plan/${digestId}/export`} download>
          <Download className="size-4" aria-hidden />
          {t("exportPdf")}
        </a>
      </Button>

      {/* `mt-1 self-start` inside `CopyButton` is for the asset cards it was
          built for; here it sits in a row, so the margin is cancelled. */}
      <CopyButton
        text={shareText}
        label={t("shareCopy")}
        copiedLabel={t("shareCopied")}
        className="mt-0 self-auto"
      />
    </div>
  );
}
