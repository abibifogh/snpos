/**
 * Where the cash went after the drawer was counted.
 *
 * Closing a shift counts the drawer. Until now nothing said what happened to
 * the cash next — left as tomorrow's float, put in the safe, or taken to the
 * bank — so the next shift was told it "starts with" money nobody may have,
 * and the cash on the books only ever grew. The close now asks, once: how
 * much into the safe, how much to the bank, and who is taking it. What is
 * left is the float the next shift opens with.
 *
 * Banking reaches the books when an admin confirms it with the slip, in
 * Settle up: the money is in the bank when the bank says so, not when
 * somebody walks out of the door with it. See cash-away-store.ts.
 *
 * Pure. Imports nothing at runtime.
 */

export interface CashPlan {
  /** Into the safe, minor units. */
  toSafe: number;
  /** Being taken to the bank, minor units. */
  toBank: number;
  /** Who is carrying it, by name. Needed whenever any leaves the drawer. */
  takenBy?: string;
}

export type CashMoveKind = 'to_safe' | 'to_bank' | 'safe_to_bank';
export type CashMoveStatus = 'in_safe' | 'pending' | 'banked';

export interface CashMove {
  $id: string;
  $createdAt?: string;
  venue_id?: string;
  kind: CashMoveKind;
  status: CashMoveStatus;
  amount: number;
  shift_id?: string;
  shift_code?: string;
  module?: string;
  taken_by?: string;
  recorded_by?: string;
  banked_at?: string;
  banked_ref?: string;
  banked_by?: string;
}

/** Cash counted in the drawers: the cash methods only. A card terminal holds nothing. */
export function cashCounted(
  counted: Record<string, number>,
  methods: { $id: string; kind?: string }[],
): number {
  return methods.filter((m) => m.kind === 'cash').reduce((n, m) => n + (counted[m.$id] ?? 0), 0);
}

/** What stays in the drawer for the next shift. */
export const keptFrom = (counted: number, plan: CashPlan): number =>
  counted - Math.max(0, plan.toSafe || 0) - Math.max(0, plan.toBank || 0);

/** Why this split cannot be saved, or null. */
export function cashPlanProblem(counted: number, plan: CashPlan): string | null {
  if ((plan.toSafe || 0) < 0 || (plan.toBank || 0) < 0) return 'An amount cannot be less than nothing.';
  if (keptFrom(counted, plan) < 0) return 'That is more than was counted in the drawer.';
  if (((plan.toSafe || 0) > 0 || (plan.toBank || 0) > 0) && !(plan.takenBy ?? '').trim()) {
    return 'Say who is taking the cash.';
  }
  return null;
}

/**
 * The float a closed shift leaves, by method, for the next shift to open on.
 *
 * Cash only, as carryOverFloats: what was counted, less what went to the
 * safe and the bank, on the first cash method. A shift closed before this
 * was asked has no plan, and leaves everything it counted, as it always did.
 */
export function keptByMethod(
  counted: Record<string, number>,
  methods: { $id: string; kind?: string }[],
  kept?: number | null,
): Record<string, number> {
  const cash = methods.filter((m) => m.kind === 'cash');
  return Object.fromEntries(methods.map((m) => {
    if (m.kind !== 'cash') return [m.$id, 0];
    if (typeof kept !== 'number') return [m.$id, counted[m.$id] ?? 0];
    return [m.$id, m.$id === cash[0]?.$id ? Math.max(0, kept) : 0];
  }));
}

/** What the safe holds: everything put in, less everything banked from it. */
export function safeBalance(moves: Pick<CashMove, 'kind' | 'amount'>[]): number {
  return moves.reduce((n, m) => n + (m.kind === 'to_safe' ? m.amount : m.kind === 'safe_to_bank' ? -m.amount : 0), 0);
}

/** Cash taken to the bank at a close, not yet confirmed with a slip. */
export const awaitingBank = <T extends Pick<CashMove, 'kind' | 'status'>>(moves: T[]): T[] =>
  moves.filter((m) => m.kind === 'to_bank' && m.status === 'pending');

/** Why banking this cannot be recorded, or null. */
export function bankingProblem(amount: number, available?: number): string | null {
  if (!(amount > 0)) return 'Give the amount that reached the bank.';
  if (typeof available === 'number' && amount > available) return 'That is more than the safe holds.';
  return null;
}
