import { listAll } from './client';
import type { FeatureFlag } from './types';

/**
 * Feature flags, resolved per venue.
 *
 * A row with a blank venue_id is the group-wide default; a row naming a venue
 * overrides it there. Nothing is hard-coded into the screens — they ask this.
 */
export interface ResolvedFeature {
  key: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export type FeatureMap = Record<string, ResolvedFeature>;

function parseConfig(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A malformed config must not take a screen down; defaults apply instead.
    return {};
  }
}

export async function loadFeatures(venueId?: string): Promise<FeatureMap> {
  const rows = await listAll<FeatureFlag>('feature_flags');
  const map: FeatureMap = {};

  // Group defaults first, then let a venue-specific row win.
  for (const r of rows.filter((r) => !r.venue_id)) {
    map[r.key] = { key: r.key, enabled: r.enabled, config: parseConfig(r.config) };
  }
  if (venueId) {
    for (const r of rows.filter((r) => r.venue_id === venueId)) {
      map[r.key] = {
        key: r.key,
        enabled: r.enabled,
        config: { ...(map[r.key]?.config ?? {}), ...parseConfig(r.config) },
      };
    }
  }
  return map;
}

export const isEnabled = (features: FeatureMap, key: string): boolean => features[key]?.enabled ?? false;

export function featureConfig<T = unknown>(features: FeatureMap, key: string, option: string, fallback: T): T {
  const v = features[key]?.config?.[option];
  return (v === undefined ? fallback : v) as T;
}

/** Features that cannot work without another being on. */
export const FEATURE_DEPENDENCIES: Record<string, string[]> = {
  loyalty: ['customers'],
};

export function unmetDependencies(features: FeatureMap, key: string): string[] {
  return (FEATURE_DEPENDENCIES[key] ?? []).filter((dep) => !isEnabled(features, dep));
}
