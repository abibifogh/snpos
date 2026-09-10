import { db, DB_ID, ID, Query, listAll } from './client';
import { featureConfig, isEnabled } from './features';
import type { FeatureMap } from './features';
import type { Module } from './access';
import { BUSY_DEFAULTS, busyLevel, busyFromQueue, overrideLive } from './busy';
import type { BusyConfig, BusyLevel, BusyOverride } from './busy';
import type { Order } from './orders';

/**
 * Reading and setting how busy the kitchen is.
 *
 * The rules are in busy.ts and are pure. This is the part that talks to the
 * database: the settings behind the switch, the tickets waiting, and the one
 * row that records a level somebody set by hand.
 */

const COLLECTION = 'kitchen_status';

/** The numbers behind the busy-mode switch, with sensible ones where it says nothing. */
export function busyConfigFrom(features: FeatureMap): BusyConfig {
  if (!isEnabled(features, 'busy_mode')) {
    // Switched off is not "never busy" written somewhere; it is the rules not
    // running at all. Thresholds of nought can never trip, and nothing holds.
    return { ...BUSY_DEFAULTS, autoTrip: false, busyAt: 0, pauseAt: 0, holdWhenPaused: false };
  }
  return {
    autoTrip: featureConfig(features, 'busy_mode', 'auto_trip', BUSY_DEFAULTS.autoTrip),
    busyAt: featureConfig(features, 'busy_mode', 'busy_pending_threshold', BUSY_DEFAULTS.busyAt),
    pauseAt: featureConfig(features, 'busy_mode', 'pause_pending_threshold', BUSY_DEFAULTS.pauseAt),
    extraMinutes: featureConfig(features, 'busy_mode', 'busy_extra_minutes', BUSY_DEFAULTS.extraMinutes),
    holdWhenPaused: featureConfig(features, 'busy_mode', 'hold_qr_orders_when_paused', BUSY_DEFAULTS.holdWhenPaused),
    guestMessage: featureConfig(features, 'busy_mode', 'message_to_guest', BUSY_DEFAULTS.guestMessage),
    overrideMinutes: featureConfig(features, 'busy_mode', 'override_minutes', BUSY_DEFAULTS.overrideMinutes),
  };
}

/**
 * How many tickets are waiting to be cooked.
 *
 * Counted per side of the business: a bar with nine drinks up says nothing
 * about whether the kitchen can take another plate. Anything already handed
 * over is not waiting for anybody.
 */
export async function ticketsWaiting(venueId: string, module: Module = 'kitchen'): Promise<number> {
  const live = await listAll<Order>('orders', [
    Query.equal('venue_id', venueId),
    Query.equal('status', ['PENDING', 'ACCEPTED', 'PREPARING']),
  ]).catch(() => [] as Order[]);
  return live.filter((o) => (o.module ?? 'kitchen') === module).length;
}

interface StatusRow {
  $id: string;
  venue_id: string;
  module?: string;
  level?: BusyLevel;
  set_by?: string;
  set_at?: string;
  note?: string;
}

const rowId = (venueId: string, module: Module) => `${venueId}-${module}`.slice(0, 36);

/** The level somebody set by hand, if there is one. Lapsing is decided in busy.ts. */
export async function loadOverride(venueId: string, module: Module = 'kitchen'): Promise<BusyOverride | null> {
  const row = await db.getDocument(DB_ID, COLLECTION, rowId(venueId, module)).catch(() => null) as StatusRow | null;
  if (!row || !row.level || !row.set_at) return null;
  return { level: row.level, at: row.set_at, by: row.set_by };
}

export interface BusyNow {
  level: BusyLevel;
  waiting: number;
  cfg: BusyConfig;
  override: BusyOverride | null;
  /** Whether the level came from a person rather than the ticket count. */
  byHand: boolean;
}

/** Everything a screen needs to say how busy it is and why. */
export async function busyNow(
  venueId: string,
  features: FeatureMap,
  module: Module = 'kitchen',
): Promise<BusyNow> {
  const cfg = busyConfigFrom(features);
  const [waiting, override] = await Promise.all([
    ticketsWaiting(venueId, module),
    loadOverride(venueId, module),
  ]);
  return {
    cfg,
    waiting,
    override,
    byHand: overrideLive(override, cfg),
    level: busyLevel({ waiting, cfg, override }),
  };
}

/**
 * Set the level by hand, or hand it back to the ticket count.
 *
 * One row per venue and side, with an id worked out from both, so setting it
 * twice replaces rather than piles up. Clearing it writes an empty level
 * instead of deleting the row: a kitchen screen that has just been handed
 * back to automatic should say so, and there is nothing to say it with if
 * the row is gone.
 */
export async function setBusyLevel(opts: {
  venueId: string;
  module?: Module;
  /** Null hands it back to the ticket count. */
  level: BusyLevel | null;
  userId: string;
  note?: string;
}): Promise<void> {
  const module = opts.module ?? 'kitchen';
  const payload = {
    venue_id: opts.venueId,
    module,
    level: opts.level ?? '',
    set_by: opts.userId,
    set_at: new Date().toISOString(),
    note: (opts.note ?? '').slice(0, 200),
  };
  await db.updateDocument(DB_ID, COLLECTION, rowId(opts.venueId, module), payload)
    .catch(() => db.createDocument(DB_ID, COLLECTION, rowId(opts.venueId, module), payload));

  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: opts.venueId,
    actor_id: opts.userId,
    action: 'busy_mode_set',
    entity_type: 'kitchen_status',
    entity_id: rowId(opts.venueId, module),
    after: JSON.stringify({ level: opts.level ?? 'automatic', module }),
    reason: opts.note ?? '',
  }).catch(() => undefined);
}

/** What the count alone would say, for a screen explaining an override. */
export const autoLevel = (waiting: number, cfg: BusyConfig): BusyLevel => busyFromQueue(waiting, cfg);
