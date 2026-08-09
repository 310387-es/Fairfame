import { ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A slot for an image that does not exist yet, which states its own brief.
 *
 * The product has no photography and `docs/15` §7 forbids inventing any, so
 * every image on this page has to come from the business. Rather than leave a
 * hole or ship a grey rectangle, the slot carries the **commission**: what the
 * picture must show, what size it has to be, and why it is there. Somebody
 * handed this page can shoot or buy the right image without asking, and a slot
 * nobody fills is visibly a slot rather than a design that happens to be empty.
 *
 * Deliberately not a stock photo and not a gradient. A placeholder that looks
 * finished is how a page ships with filler in it: this one is dashed, labelled,
 * and impossible to mistake for the real thing at any zoom.
 *
 * It renders in **both** environments on purpose. A placeholder that hides in
 * production is a blank space nobody notices until a customer does.
 */
export function PlaceholderImage({
  /** What the picture must show. Written for whoever will supply it. */
  brief,
  /** Intended intrinsic size, e.g. "1600 × 900". */
  size,
  /** Why the page needs it — the job it does, not the subject. */
  purpose,
  className,
}: {
  brief: string;
  size: string;
  purpose: string;
  className?: string;
}) {
  return (
    <figure
      className={cn(
        "flex flex-col justify-center gap-2 rounded-lg border border-dashed border-line bg-surface-sunken p-6",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <ImageIcon aria-hidden className="size-4 shrink-0 text-graphic-faint" />
        <span className="text-eyebrow text-faint uppercase">{size}</span>
      </div>

      <figcaption className="text-copy leading-relaxed text-pretty">
        <span className="font-semibold text-foreground">{brief}</span>{" "}
        <span className="text-faint">{purpose}</span>
      </figcaption>
    </figure>
  );
}
