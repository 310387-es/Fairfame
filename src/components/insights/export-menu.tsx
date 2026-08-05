import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Range } from "@/dashboard/range";
import type { ExportKind } from "@/insights/export";

/**
 * Taking the numbers away (P3-T4).
 *
 * Plain links, not fetch-and-blob: the browser already knows how to download a
 * response with `Content-Disposition`, and doing it by hand would mean holding
 * the file in memory, minting an object URL and revoking it — three chances to
 * leak for no gain. It also means the export works with scripts off, which is
 * the same reason the range control is links.
 *
 * The range travels with the link, so an export is always of what is on screen.
 * An export that quietly covered a different window than the page it was taken
 * from would be worse than no export.
 */
export function ExportMenu({
  range,
  label,
  kinds,
  labels,
  pdfLabel,
}: {
  range: Range;
  label: string;
  kinds: readonly ExportKind[];
  labels: Record<ExportKind, string>;
  /** The whole page as a PDF — the same document the scheduled report mails. */
  pdfLabel: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Download className="size-4" aria-hidden />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* First, because it is the one most people want: the page, as a
            document, rather than a table to do arithmetic on. */}
        <DropdownMenuItem asChild>
          <a href={`/insights/export?format=pdf&range=${range}`} download>
            {pdfLabel}
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {kinds.map((kind) => (
          <DropdownMenuItem key={kind} asChild>
            {/* `download` is advisory; the route sets Content-Disposition,
                which is what actually names the file. */}
            <a href={`/insights/export?format=csv&kind=${kind}&range=${range}`} download>
              {labels[kind]}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
