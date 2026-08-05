"use client";

import { Check, Code2, Eye, Settings2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { SectionCard } from "@/components/ds/section-card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LOCALES } from "@/i18n/config";
import { useAction } from "@/components/ui/use-action";
import { saveWidgetAction, setWidgetPublishedAction } from "@/server/widgets";
import {
  SIZE_MESSAGE_TYPE,
  isBadgeLayout,
  MAX_WIDGET_REVIEWS,
  WIDGET_LAYOUTS,
  WIDGET_THEMES,
  widgetConfigToParams,
  type WidgetFilters,
  type WidgetStyle,
} from "@/widgets/config";
import { EmbedSnippet } from "./embed-snippet";

/**
 * The widget builder (P3-T1): configure, preview, publish.
 *
 * **The preview is the real thing.** It is an iframe pointing at
 * `/widgets/{id}/preview`, which runs the same renderer, the same scope clauses
 * and the same config schema the live embed does — so what appears here is what
 * a visitor gets, not a React approximation of it that will disagree the first
 * time either side changes. The unsaved form state travels as a query string
 * through `widgetConfigToParams`, the one place a config becomes a URL.
 *
 * Local state, not the URL, for the form itself: nothing the *server* needs to
 * know changes as you drag a control, and putting it in the address bar would
 * make every checkbox a navigation.
 */
/**
 * A floor for the preview, so the frame is a visible panel rather than a
 * hairline in the moment before its first measurement arrives.
 *
 * Deliberately low, and deliberately only the *starting* value: once the frame
 * has measured itself the number it sends wins outright. Anything generous
 * enough to look right for a full grid reintroduces exactly the dead space the
 * self-measuring frame exists to remove, and an empty widget renders a real
 * empty-state box, so there is nothing to pad out.
 */
const MIN_PREVIEW_HEIGHT = 120;

export function WidgetBuilder({
  widgetId,
  publicKey,
  embedOrigin,
  initialName,
  initialLocationId,
  initialFilters,
  initialStyle,
  initialPublished,
  approvedRevision,
  locations,
  sources,
  canManage,
  approvals,
}: {
  widgetId: string;
  publicKey: string;
  embedOrigin: string;
  initialName: string;
  initialLocationId: string | null;
  initialFilters: WidgetFilters;
  initialStyle: WidgetStyle;
  initialPublished: boolean;
  /**
   * Changes whenever the set of approved reviews does. Not a config value — a
   * signal that the preview's *data* moved even though its settings did not.
   */
  approvedRevision: number;
  locations: { id: string; name: string }[];
  /** Connector sources this organization actually has reviews from. */
  sources: string[];
  canManage: boolean;
  /**
   * The approval list, rendered on the server and handed down rather than
   * placed beside this component on the page.
   *
   * It is here because whether it belongs on the screen depends on a value only
   * this component knows: the layout currently selected in the form, which is
   * not the layout the widget was last *saved* with. Choosing a badge has to
   * take the list away in the same moment it takes the preview to a badge —
   * leaving it up until the next save would mean approving reviews for a widget
   * that is, right now, showing none of them.
   */
  approvals: ReactNode;
}) {
  const t = useTranslations("widgets");
  const tf = useTranslations("feedback");
  const [name, setName] = useState(initialName);
  const [locationId, setLocationId] = useState(initialLocationId ?? "all");
  const [filters, setFilters] = useState(initialFilters);
  const [style, setStyle] = useState(initialStyle);
  const [published, setPublished] = useState(initialPublished);
  const [saved, setSaved] = useState(true);
  const { run, pending } = useAction();

  /**
   * A badge draws the aggregate, not the reviews — so every control that picks
   * *which* reviews is inert while it is selected, and so is the approval list.
   *
   * They are removed rather than disabled. A disabled control says "not now";
   * these will never do anything for this layout, and leaving them on screen
   * would tell a business its badge can be filtered to its best reviews. It
   * cannot, by design — see `PublicAggregate` in `src/widgets/public.ts`.
   *
   * Branch and sources stay: they are the badge's *scope*, and they do move the
   * number.
   */
  const isBadge = isBadgeLayout(style.layout);

  const patchFilters = (patch: Partial<WidgetFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setSaved(false);
  };
  const patchStyle = (patch: Partial<WidgetStyle>) => {
    setStyle((current) => ({ ...current, ...patch }));
    setSaved(false);
  };

  /**
   * The preview URL.
   *
   * Memoized so it does not change on every render — otherwise React sees a new
   * `src` and the iframe reloads on each keystroke in the name field, which
   * does not even affect the preview.
   *
   * `approvedRevision` is in the dependencies because **the config is not the
   * only thing the preview depends on**. Approving a review changes what the
   * widget renders without changing a single setting, so with config alone the
   * iframe kept showing the "nothing approved yet" empty state after a business
   * had just approved everything — the exact bug this parameter fixes. The
   * value comes from the server page, which re-renders on `router.refresh()`
   * after every approval, so the preview follows the data rather than guessing.
   */
  const previewSrc = useMemo(() => {
    const params = widgetConfigToParams({ filters, style });
    params.set("v", String(approvedRevision));
    return `/widgets/${widgetId}/preview?${params.toString()}`;
  }, [widgetId, filters, style, approvedRevision]);

  /**
   * The preview is the size of the widget, and no bigger.
   *
   * It used to be a fixed 520px box, which left a slab of dead space under a
   * short widget — a one-row carousel is about 255px — and that space is not
   * even reliably white: the frame document is deliberately transparent so a
   * real embed blends into a customer's page, so what shows through underneath
   * is the browser's own canvas, which is black for anyone in dark mode.
   *
   * The fix is the mechanism the real embed already uses. The frame measures
   * itself and posts its size; the loader script listens for that on a
   * customer's site, and so does this. Same message, same numbers, so the
   * preview is sized by exactly what will size it in the wild — including the
   * width, which only an inline-sized widget (the rating badge) reports. A null
   * width means "fill the slot", which is every other layout.
   */
  const previewFrame = useRef<HTMLIFrameElement>(null);
  const [previewSize, setPreviewSize] = useState<{ height: number; width: number | null }>({
    height: MIN_PREVIEW_HEIGHT,
    width: null,
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Identified by window, not by anything in the payload: a string in the
      // message could be sent by any frame on the page, this cannot.
      if (event.source !== previewFrame.current?.contentWindow) return;

      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const message = data as { type?: unknown; height?: unknown; width?: unknown };
      if (message.type !== SIZE_MESSAGE_TYPE) return;

      const height = Number(message.height);
      if (!Number.isFinite(height) || height <= 0) return;

      const width = Number(message.width);
      setPreviewSize({
        // No floor once a real measurement has arrived — the floor is the
        // *initial* value, for the moment before the frame has spoken. Clamping
        // afterwards put a 120px box around a 44px rating badge, which is the
        // same slab of dead space this mechanism exists to remove, and on the
        // dark theme it showed as the browser's black canvas under the widget.
        height: Math.ceil(height),
        // Read every time, not only when present: switching a badge back to a
        // grid has to widen the frame again, and a remembered width would leave
        // the wall rendering in a 200px column.
        width: Number.isFinite(width) && width > 0 ? Math.ceil(width) : null,
      });
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const save = () => {
    run(
      () =>
        saveWidgetAction({
          id: widgetId,
          name,
          locationId: locationId === "all" ? "" : locationId,
          filters,
          style,
        }),
      { success: tf("saved"), onSuccess: () => setSaved(true) },
    );
  };

  const togglePublished = () => {
    run(() => setWidgetPublishedAction({ id: widgetId, published: !published }), {
      success: published ? tf("unpublished") : tf("published"),
      onSuccess: () => setPublished(!published),
    });
  };

  return (
    <>
      <div className="grid gap-(--grid-gap) lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:items-start">
        <SectionCard title={t("settingsTitle")} icon={Settings2}>
          <div className="flex flex-col gap-4 pb-(--card-py)">
            <div className="space-y-2">
              <Label htmlFor="w-name">{t("nameLabel")}</Label>
              <Input
                id="w-name"
                value={name}
                maxLength={80}
                disabled={!canManage}
                onChange={(event) => {
                  setName(event.target.value);
                  setSaved(false);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="w-location">{t("locationLabel")}</Label>
              <Select
                value={locationId}
                disabled={!canManage}
                onValueChange={(value) => {
                  setLocationId(value);
                  setSaved(false);
                }}
              >
                <SelectTrigger id="w-location">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("allLocations")}</SelectItem>
                  {locations.map((location) => (
                    <SelectItem key={location.id} value={location.id}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Choice
              id="w-layout"
              label={t("layoutLabel")}
              hint={isBadge ? t("badgeNote") : undefined}
              value={style.layout}
              options={WIDGET_LAYOUTS.map((value) => ({ value, label: t(`layout.${value}`) }))}
              disabled={!canManage}
              onChange={(value) => patchStyle({ layout: value as WidgetStyle["layout"] })}
            />

            <Choice
              id="w-theme"
              label={t("themeLabel")}
              hint={t("themeHint")}
              value={style.theme}
              options={WIDGET_THEMES.map((value) => ({ value, label: t(`theme.${value}`) }))}
              disabled={!canManage}
              onChange={(value) => patchStyle({ theme: value as WidgetStyle["theme"] })}
            />

            <Choice
              id="w-locale"
              label={t("localeLabel")}
              hint={t("localeHint")}
              value={style.locale ?? "auto"}
              options={[
                { value: "auto", label: t("localeAuto") },
                ...LOCALES.map((value) => ({ value, label: t(`locale.${value}`) })),
              ]}
              disabled={!canManage}
              onChange={(value) =>
                patchStyle({ locale: value === "auto" ? null : (value as WidgetStyle["locale"]) })
              }
            />

            {isBadge ? null : (
              <>
                <Choice
                  id="w-min"
                  label={t("minRatingLabel")}
                  hint={t("minRatingHint")}
                  value={String(filters.minRating ?? "any")}
                  options={[
                    { value: "any", label: t("minRatingAny") },
                    ...[5, 4, 3, 2].map((rating) => ({
                      value: String(rating),
                      label: t("minRatingOption", { rating }),
                    })),
                  ]}
                  disabled={!canManage}
                  onChange={(value) =>
                    patchFilters({ minRating: value === "any" ? null : Number(value) })
                  }
                />

                <div className="space-y-2">
                  <Label htmlFor="w-count">{t("countLabel")}</Label>
                  <Input
                    id="w-count"
                    type="number"
                    min={1}
                    max={MAX_WIDGET_REVIEWS}
                    value={filters.count}
                    disabled={!canManage}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isInteger(next) && next >= 1 && next <= MAX_WIDGET_REVIEWS) {
                        patchFilters({ count: next });
                      }
                    }}
                  />
                </div>
              </>
            )}

            {sources.length > 1 ? (
              <fieldset className="space-y-2">
                <legend className="text-copy font-semibold">{t("sourcesLabel")}</legend>
                <p className="text-meta text-faint">{t("sourcesHint")}</p>
                {sources.map((source) => (
                  <Toggle
                    key={source}
                    id={`w-source-${source}`}
                    label={source.charAt(0).toUpperCase() + source.slice(1)}
                    checked={filters.sources.includes(source)}
                    disabled={!canManage}
                    onChange={(checked) =>
                      patchFilters({
                        sources: checked
                          ? [...filters.sources, source]
                          : filters.sources.filter((entry) => entry !== source),
                      })
                    }
                  />
                ))}
              </fieldset>
            ) : null}

            {/* Every toggle in here describes a review card, and a badge has no
              cards — the author, the source, the date and the two selection
              rules are all inert. It goes as a block rather than a toggle at a
              time, because a "Show" fieldset with nothing in it that shows is
              worse than no fieldset. */}
            {isBadge ? null : (
              <fieldset className="space-y-2">
                <legend className="text-copy font-semibold">{t("showLabel")}</legend>
                <Toggle
                  id="w-author"
                  label={t("showAuthor")}
                  checked={style.showAuthor}
                  disabled={!canManage}
                  onChange={(checked) => patchStyle({ showAuthor: checked })}
                />
                <Toggle
                  id="w-source"
                  label={t("showSource")}
                  checked={style.showSource}
                  disabled={!canManage}
                  onChange={(checked) => patchStyle({ showSource: checked })}
                />
                <Toggle
                  id="w-date"
                  label={t("showDate")}
                  checked={style.showDate}
                  disabled={!canManage}
                  onChange={(checked) => patchStyle({ showDate: checked })}
                />
                <Toggle
                  id="w-text"
                  label={t("requireText")}
                  hint={t("requireTextHint")}
                  checked={filters.requireText}
                  disabled={!canManage}
                  onChange={(checked) => patchFilters({ requireText: checked })}
                />
                <Toggle
                  id="w-comments"
                  label={t("includeSocial")}
                  hint={t("includeSocialHint")}
                  checked={filters.itemTypes.length === 0}
                  disabled={!canManage}
                  onChange={(checked) => patchFilters({ itemTypes: checked ? [] : ["review"] })}
                />
              </fieldset>
            )}

            {canManage ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" onClick={save} disabled={pending || saved}>
                  {saved ? (
                    <>
                      <Check className="size-4" aria-hidden />
                      {t("saved")}
                    </>
                  ) : (
                    t(pending ? "saving" : "save")
                  )}
                </Button>

                <Button
                  type="button"
                  variant={published ? "outline" : "default"}
                  onClick={togglePublished}
                  disabled={pending}
                >
                  {published ? t("unpublish") : t("publish")}
                </Button>
              </div>
            ) : null}

            {/* The one thing a draft/live badge cannot say: what changes. */}
            <p className="text-meta text-faint">
              {published ? t("publishedNote") : t("draftNote")}
            </p>
          </div>
        </SectionCard>

        <div className="flex flex-col gap-(--grid-gap)">
          <SectionCard
            title={t("previewTitle")}
            icon={Eye}
            meta={saved ? undefined : t("previewUnsaved")}
            flush
          >
            <div className="border-t border-line-soft bg-canvas p-3">
              <iframe
                ref={previewFrame}
                // Not keyed on `previewSrc`: remounting the element on every
                // config change would drop the message listener's target mid-flight
                // and briefly collapse the frame back to its minimum. Changing
                // `src` alone reloads the document and keeps the element.
                src={previewSrc}
                title={t("previewTitle")}
                // Width from the frame when it is inline-sized, otherwise the
                // whole slot. `max-w-full` so a measurement can never push the
                // panel sideways.
                style={{ height: previewSize.height, width: previewSize.width ?? "100%" }}
                className="block max-w-full rounded-md border border-line bg-card transition-[height] duration-180"
              />
            </div>
          </SectionCard>

          <SectionCard title={t("embedTitle")} icon={Code2}>
            <EmbedSnippet
              publicKey={publicKey}
              origin={embedOrigin}
              published={published}
              widgetName={name}
              // The live value, not the saved one: the snippet's first-paint
              // size follows the layout in the form, like everything else here.
              layout={style.layout}
            />
          </SectionCard>
        </div>
      </div>

      {isBadge ? null : approvals}
    </>
  );
}

/** A labelled select — the shape this form uses six times. */
function Choice({
  id,
  label,
  hint,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint ? <p className="text-meta text-faint">{hint}</p> : null}
    </div>
  );
}

/** A checkbox with its label and optional explanation. */
function Toggle({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
        className="mt-0.5"
      />
      <div className="min-w-0">
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
        {hint ? <p className="text-meta text-faint">{hint}</p> : null}
      </div>
    </div>
  );
}
