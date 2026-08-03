import { getProvider, PROVIDERS, resolveMode, type ProviderMode } from "./providers.ts";
import type { Capability } from "./types.ts";

/**
 * What a source's declared capabilities mean on screen.
 *
 * The UI must never hard-code "Google can reply, Yelp cannot". It asks a
 * connector what it can do and renders that, which is the only reason adding a
 * provider is a registry entry rather than a sweep through the components.
 * `docs/03-technical-architecture.md` §4 states the rule: a `reply: 'none'`
 * source shows "Open on platform" instead of a reply box, and a
 * `read: 'excerpt'` source is labelled *Monitor only*.
 *
 * Pure, and separate from the components, so the mapping can be tested without
 * rendering anything.
 */

/** How much of the source we can actually pull. */
export type SyncKind = "live" | "monitor" | "outbound";

/** What the review card should offer. */
export type ReplyAffordance = "compose" | "open_on_platform" | "none";

export type CapabilityView = {
  provider: string;
  label: string;
  capabilities: Capability;
  sync: SyncKind;
  reply: ReplyAffordance;
  /** True while the source is serving seeded data rather than the platform. */
  isMock: boolean;
  mode: ProviderMode;
  /** Why a provider asked to be live is not — missing credentials or vault. */
  modeReason?: "missing_credentials" | "missing_vault";
  /** Whether a live connection can be started from the UI right now. */
  canAuthorize: boolean;
  /** What still stands between this provider and go-live. */
  goLiveNote?: string;
};

export function syncKindOf(capabilities: Capability): SyncKind {
  switch (capabilities.read) {
    case "full":
      return "live";
    case "excerpt":
      // We only ever see a truncated review, so the source is worth watching
      // but cannot be the system of record.
      return "monitor";
    case "none":
      return "outbound";
  }
}

export function replyAffordanceOf(capabilities: Capability): ReplyAffordance {
  switch (capabilities.reply) {
    case "api":
      return "compose";
    case "manual":
      // We hold no way to post, but the platform does — send them there.
      return "open_on_platform";
    case "none":
      return "open_on_platform";
  }
}

/**
 * The view model for a provider in this environment.
 *
 * Note that capabilities come from the descriptor, not from whichever
 * implementation is currently resolved: a mocked Google still declares Google's
 * abilities, so what an owner sees on sample data is what they will see when
 * the flag flips.
 */
export function describeProvider(provider: string): CapabilityView | null {
  const descriptor = getProvider(provider);
  if (!descriptor) return null;

  const resolution = resolveMode(provider);

  return {
    provider,
    label: descriptor.label,
    capabilities: descriptor.capabilities,
    sync: syncKindOf(descriptor.capabilities),
    reply: replyAffordanceOf(descriptor.capabilities),
    isMock: resolution.mode === "mock",
    mode: resolution.mode,
    ...(resolution.reason ? { modeReason: resolution.reason } : {}),
    // Only a provider that is genuinely live has a consent screen to visit.
    canAuthorize: resolution.mode === "real" && descriptor.requiresOAuth,
    ...(descriptor.goLiveNote ? { goLiveNote: descriptor.goLiveNote } : {}),
  };
}

/**
 * Capability views for the sources an organization could add, keyed by
 * provider. Providers switched off in this environment are absent.
 */
export function describeConnectableProviders(): CapabilityView[] {
  return Object.keys(PROVIDERS)
    .map(describeProvider)
    .filter((view): view is CapabilityView => view !== null && view.mode !== "off")
    .sort((left, right) => left.label.localeCompare(right.label));
}
