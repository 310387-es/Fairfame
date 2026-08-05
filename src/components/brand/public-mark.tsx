import { Logo } from "@/components/brand/logo";
import type { Brand } from "@/agency/branding";

/**
 * Whose mark sits at the foot of a customer-facing page (P4-T5).
 *
 * Three states, and the middle one is what white-label is:
 *
 *   - **An agency's logo**, when this organization has an agency whose plan
 *     includes `white_label` and which has uploaded one. Our name is gone.
 *   - **An agency's name in words**, when it has no logo. Better than falling
 *     back to ours: the point is that the customer sees who they deal with.
 *   - **Revira**, otherwise — including for an ordinary business that has
 *     branded its own page, because branding your own page is not the same as
 *     buying the right to remove somebody else's mark.
 *
 * `showPoweredBy` is resolved in `src/agency/branding.ts`, never here. This
 * component paints; it does not decide who is entitled to what.
 */
export function PublicMark({ brand, className }: { brand: Brand; className?: string }) {
  if (brand.whiteLabelled) {
    return (
      <div className={className}>
        {brand.logoUrl ? (
          // A remote image on a public page, sized by height so an agency's
          // wordmark and an agency's square badge both land somewhere sensible.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brand.logoUrl} alt={brand.name} className="h-5 w-auto" />
        ) : (
          <span className="text-copy font-semibold text-muted-foreground">{brand.name}</span>
        )}
      </div>
    );
  }

  if (!brand.showPoweredBy) return null;

  return (
    <div className={className}>
      <Logo className="text-muted-foreground" markClassName="size-4" />
    </div>
  );
}
