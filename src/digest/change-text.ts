import type { WindowChange } from "./metrics.ts";

/**
 * Turning a stored change into a sentence.
 *
 * Shared by Home and the public sample, which is the point: the pipeline stores
 * `{kind, direction, detail}` rather than prose precisely so the same digest can
 * be read in either language, and having two renderers would let one of them
 * drift. The sample page had already drifted into printing "84.8 → 62.9" while
 * Home said "Reputation moved from 84.8 to 62.9".
 *
 * Takes a translator rather than importing one, so it works from a server
 * component in any namespace that carries the five `change*` keys.
 */
export type ChangeTranslator = (
  key:
    | "changePulse"
    | "changeVolumeUp"
    | "changeVolumeDown"
    | "changeThemeNew"
    | "changeThemeRising"
    | "changeThemeFalling",
  values: Record<string, string>,
) => string;

export function formatChange(change: WindowChange, t: ChangeTranslator): string {
  const detail = change.detail as Record<string, string | number>;

  if (change.kind === "pulse") {
    return t("changePulse", { from: String(detail.from), to: String(detail.to) });
  }

  if (change.kind === "volume") {
    const percent = Number(detail.percent);
    // The sign lives in the wording, not glued to the percent mark: "%-50" is
    // not how a percentage is written in either language.
    return t(percent >= 0 ? "changeVolumeUp" : "changeVolumeDown", {
      from: String(detail.from),
      to: String(detail.to),
      percent: String(Math.abs(percent)),
    });
  }

  if (detail.status === "new") {
    return t("changeThemeNew", { label: String(detail.label), count: String(detail.count) });
  }

  return detail.status === "rising"
    ? t("changeThemeRising", {
        label: String(detail.label),
        from: String(detail.from),
        to: String(detail.to),
      })
    : t("changeThemeFalling", {
        label: String(detail.label),
        from: String(detail.from),
        to: String(detail.to),
      });
}
