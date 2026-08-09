import { z } from "zod";
import { VERTICALS } from "@/reviews/taxonomy";
import { msg } from "@/lib/validation-keys";

/**
 * Input schemas for the location server actions.
 *
 * Kept out of the "use server" module because those may only export async
 * functions — which also means the validation would otherwise be untestable.
 *
 * The `.nullish()` here is load-bearing. `FormData.get()` returns `null` for an
 * absent field, never `undefined`, so a plain `.optional()` rejects every
 * submission that leaves an optional input blank. That failure is especially
 * nasty because from the outside it is indistinguishable from a permission
 * denial: the write simply does not happen.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value == null || value === "" ? null : value));

export const createLocationSchema = z.object({
  name: z.string().trim().min(1, msg("required")).max(120),
  address: optionalText(240),
  /**
   * The business's vertical, from the closed list (W3.2).
   *
   * Was free text, which meant it could not drive anything. It picks the
   * canonical themes the model is offered, so an unrecognised value is not a
   * harmless label — it silently narrows every review to the universal themes.
   * Validated here rather than only in the form, because a form is a
   * suggestion and a schema is the rule.
   *
   * Still optional: a business that has not said what it is gets the universal
   * themes, which is most of what matters, and demanding an answer before a
   * location can exist would put a taxonomy in front of the first-run flow.
   */
  category: z.preprocess(
    // Blank means "not set" rather than invalid. A `<select>` posts `""` when
    // nothing is chosen, and failing the whole form over that would put a
    // taxonomy in front of creating a location.
    (value) => {
      const text = typeof value === "string" ? value.trim() : value;
      return text === "" || text == null ? null : text;
    },
    z.enum(VERTICALS).nullable(),
  ),
});

export type CreateLocationInput = z.infer<typeof createLocationSchema>;

/** Reads the action's fields straight off a FormData, nulls and all. */
export function parseCreateLocation(formData: FormData) {
  return createLocationSchema.safeParse({
    name: formData.get("name"),
    address: formData.get("address"),
    category: formData.get("category"),
  });
}

export const connectSourceSchema = z.object({ locationId: z.uuid() });
export const syncNowSchema = z.object({ connectionId: z.uuid() });
