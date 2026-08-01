import { z } from "zod";

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
  name: z.string().trim().min(1, "A name is required.").max(120),
  address: optionalText(240),
  category: optionalText(80),
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
