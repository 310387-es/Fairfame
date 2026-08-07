/**
 * Where a redirect around the authentication screens may point.
 *
 * **Only a same-origin path is honoured.** A full URL here would be an open
 * redirect — `?next=https://evil.test` on a page that has just taken a
 * password — and `//evil.test` is a URL wearing a path's clothes. A backslash
 * in the second position is rejected for the same reason: browsers normalise
 * `\` to `/` while parsing, so `/\evil.test` reaches the network as a host.
 *
 * Db-free and framework-free on purpose. The sign-in and sign-up forms are
 * client components and the guards that bounce an already-signed-in visitor
 * away are server components; a second copy of this rule is a second place for
 * the `//` case to be forgotten, which is how an open redirect ships.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/")) return null;
  if (value[1] === "/" || value[1] === "\\") return null;
  return value;
}
