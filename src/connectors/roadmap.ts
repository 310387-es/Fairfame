/**
 * The sources we have **not** built (W4.2).
 *
 * ## Why this is a separate list and must stay one
 *
 * The obvious move is to add Facebook and Yemeksepeti to `PROVIDERS` with a
 * flag saying "not ready". That would be wrong in a way this codebase has been
 * bitten by before (`iys_uploaded_via`, `COMPETITOR_SOURCE`): `PROVIDERS` is
 * read by the connector registry, the connect flow, the sync scheduler, the
 * capability view and `pnpm golive`, and every one of them reasonably assumes a
 * descriptor has a connector behind it. A "not ready" descriptor is a connect
 * button one forgotten `if` away from throwing at an OAuth callback, and a
 * go-live report that lists sources nobody can ever go live on.
 *
 * So a roadmap entry has **no descriptor**: no capabilities, no OAuth
 * endpoints, no rate limit, no mode. There is nothing here for a connector to
 * be resolved from, which is what makes it impossible to accidentally connect
 * one. Its entire affordance is a button that records that somebody wanted it.
 *
 * ## Why show them at all
 *
 * A café owner in Kadıköy gets more reviews on Yemeksepeti than on Google. If
 * the Connections screen shows two cards and stops, the honest reading is "this
 * product does not know my business exists". Listing what we do not have — and
 * letting them say they want it — is the difference between an empty grid and a
 * roadmap, and the presses are the only real evidence we will ever get about
 * what to build next.
 *
 * The entries are ordered by how often we expect to be asked, which is also the
 * order they render in. `mark` names a brand mark in
 * `src/components/connections/provider-mark.tsx`; nothing here imports it,
 * because this module is db-free and React-free so the server, the tests and
 * `pnpm golive` can all read it.
 */

export type RoadmapSource = {
  key: string;
  label: string;
  /**
   * Why a business would want it, in one clause. Not marketing copy — the
   * reason it is on the list, so somebody triaging the requests can tell a
   * Turkish delivery platform from a global review site at a glance.
   */
  note: "delivery" | "reviews" | "social";
};

export const ROADMAP_SOURCES: readonly RoadmapSource[] = [
  // The Turkish delivery platforms. First because they are the local moat: no
  // international competitor reads them, and for a restaurant they carry more
  // review volume than Google does.
  { key: "yemeksepeti", label: "Yemeksepeti", note: "delivery" },
  { key: "getir", label: "Getir", note: "delivery" },
  { key: "trendyol_yemek", label: "Trendyol Yemek", note: "delivery" },

  { key: "facebook", label: "Facebook", note: "social" },
  { key: "tripadvisor", label: "Tripadvisor", note: "reviews" },
  { key: "trustpilot", label: "Trustpilot", note: "reviews" },
] as const;

export const ROADMAP_KEYS: readonly string[] = ROADMAP_SOURCES.map((source) => source.key);

export function isRoadmapSource(key: string): boolean {
  return ROADMAP_KEYS.includes(key);
}
