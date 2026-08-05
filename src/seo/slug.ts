/**
 * The address of a hosted review page, made out of a business's own words.
 *
 * Db-free on purpose: uniqueness needs the database, but *what a name turns
 * into* does not, and it is the part with all the edge cases. Tests can hold
 * the whole rule without a connection.
 *
 * **Turkish is the reason this is not four lines.** The launch market writes
 * ı, ş, ğ, ç, ö, ü and İ, and NFD-normalising those the way one would for
 * French does not work: `ı` is not `i` with a mark, and `ğ` decomposes to `g` +
 * a breve in a way that would silently drop the letter. So the six that matter
 * are transliterated explicitly, before anything else touches the string.
 *
 * `İ` is the one that surprises people. Lowercasing it in a Turkish locale
 * gives `i`, and in every other locale gives `i` plus a combining dot — so a
 * café called `İstanbul` would slug differently depending on where the server
 * thought it was. It is mapped by hand, ahead of `toLowerCase()`, so the answer
 * is the same everywhere.
 */

/**
 * Turkish letters, and the Latin letter each one is read as.
 *
 * Deliberately not a general transliteration table: this is the set the launch
 * market actually types. Everything else falls through to the NFD pass, which
 * handles the accented Latin the rest of Europe writes.
 */
const TURKISH: Record<string, string> = {
  ı: "i",
  İ: "i",
  ş: "s",
  Ş: "s",
  ğ: "g",
  Ğ: "g",
  ç: "c",
  Ç: "c",
  ö: "o",
  Ö: "o",
  ü: "u",
  Ü: "u",
};

/** Long enough to be descriptive, short enough to survive a search result. */
const MAX_SLUG_LENGTH = 80;

/**
 * A name → the URL-safe form of it.
 *
 * Returns an empty string when there is nothing left, which is a real case: a
 * location named only in a script this does not transliterate (Arabic, Greek,
 * an emoji) reduces to nothing. The caller decides what to do about it rather
 * than getting a slug made of hyphens.
 */
export function slugify(value: string): string {
  const transliterated = [...value].map((character) => TURKISH[character] ?? character).join("");

  return (
    transliterated
      .toLowerCase()
      // Splits the accented Latin the six above did not cover — é, ñ, å — into a
      // base letter plus a combining mark, and drops the mark.
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      // Anything that is not a plain letter or digit becomes a boundary. `&`,
      // apostrophes and dots in "St. Mary's Café & Co." all collapse here.
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SLUG_LENGTH)
      // The slice can leave a trailing hyphen behind.
      .replace(/-+$/g, "")
  );
}

/**
 * The slug a location would like, before uniqueness is considered.
 *
 * Both names, because a chain's "Kadıköy" branch and a different chain's
 * "Kadıköy" branch would otherwise fight over one word — and because the
 * business's own name is the term a searcher actually types.
 */
export function preferredSlug(organizationName: string, locationName: string): string {
  const organization = slugify(organizationName);
  const location = slugify(locationName);

  // A single-location business often names the location after itself, and
  // "kadikoy-kahve-kadikoy-kahve" is not a better URL than "kadikoy-kahve".
  if (!location || location === organization) return organization;
  if (!organization) return location;

  return slugify(`${organization} ${location}`);
}

/**
 * The first candidate not already taken.
 *
 * Numbered rather than random: `-2` reads as "the second one of these", which
 * is what it is, and a business looking at two of its own URLs can tell them
 * apart. The taken-check is a callback so this stays db-free and the caller
 * keeps the query in its own tenant-scoped layer.
 *
 * The fallback matters more than it looks. If a name transliterates to nothing
 * at all, there is no readable slug to be had, and a page with no address is
 * worse than one with an unlovely address — so it borrows the random-code
 * primitive every other public URL in the product already uses.
 */
export async function uniqueSlug(
  preferred: string,
  isTaken: (candidate: string) => Promise<boolean>,
  fallback: () => string,
): Promise<string> {
  const base = preferred || fallback();

  if (!(await isTaken(base))) return base;

  // Bounded: past a handful of collisions the names are not distinguishing
  // anything, and a loop against a unique index is not where to discover that.
  for (let suffix = 2; suffix <= 20; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }

  return `${base}-${fallback()}`;
}
