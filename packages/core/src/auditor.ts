import type { CountCharge, CountDecision } from './count-charges';

/**
 * The auditor: somebody whose job is the counts and what they find.
 *
 * They review every count difference, ask the person about it, keep notes,
 * and chase what is due. They decide a difference on their own up to a limit
 * the owner sets (under Features, on Count differences); above it they
 * recommend, and an admin or a manager confirms. They never sell, count stock
 * or open a till, so the person checking is never the person being checked.
 *
 * Nobody decides a difference charged to themselves, whatever their role.
 *
 * The same rules are applied by the server before anything is written. See
 * functions/notify/src/count-charges.js.
 */

/** The limit, in whole currency units, until the owner sets one. */
export const AUDITOR_LIMIT_UNITS = 100;

/** The auditor's limit in minor units: what the feature says, or 100 of the currency. */
export function auditorLimit(config: { auditor_limit?: unknown } | null | undefined, decimals = 2): number {
  const set = Number(config?.auditor_limit);
  if (Number.isFinite(set) && set >= 0) return Math.round(set);
  return AUDITOR_LIMIT_UNITS * 10 ** Math.max(0, decimals);
}

export type DecisionRight = 'decide' | 'recommend' | 'none';

export interface Decider {
  $id?: string;
  user_id?: string | null;
  role?: string | null;
  active?: boolean | null;
}

/** Whether this charge is on this person's own account. */
export const isOwnCharge = (
  c: Pick<CountCharge, 'person_id' | 'person_user_id'>,
  who: Decider | null | undefined,
): boolean =>
  !!who && ((!!who.$id && who.$id === c.person_id) || (!!who.user_id && !!c.person_user_id && who.user_id === c.person_user_id));

/**
 * What this person may do with this difference: decide it, recommend a
 * decision for somebody senior to confirm, or nothing.
 */
export function decisionRight(
  c: Pick<CountCharge, 'person_id' | 'person_user_id' | 'amount'>,
  who: Decider | null | undefined,
  limit: number,
): DecisionRight {
  if (!who || who.active === false) return 'none';
  if (isOwnCharge(c, who)) return 'none';
  if (who.role === 'admin' || who.role === 'manager') return 'decide';
  if (who.role === 'auditor') return (c.amount || 0) <= limit ? 'decide' : 'recommend';
  return 'none';
}

/** Why this person cannot decide this one, in words for the screen, or null. */
export function decisionRightWords(
  c: Pick<CountCharge, 'person_id' | 'person_user_id' | 'amount' | 'person_name'>,
  who: Decider | null | undefined,
  limit: number,
  money: (n: number) => string,
): string | null {
  if (isOwnCharge(c, who)) return 'This one is on your own account, so somebody else decides it.';
  const right = decisionRight(c, who, limit);
  if (right === 'recommend') {
    return `Above your limit of ${money(limit)}, so you recommend and an admin or a manager confirms.`;
  }
  if (right === 'none') return 'Only an admin, a manager or an auditor decides a count difference.';
  return null;
}

export interface Recommendation {
  decision: Exclude<CountDecision, 'pending'>;
  amount: number;
  note: string;
}

/** Why this recommendation cannot be sent, or null. Same rules as a decision. */
export function recommendProblem(
  c: Pick<CountCharge, 'decision' | 'amount' | 'answer'>,
  r: Recommendation,
): string | null {
  if (c.decision !== 'pending') return 'This has already been decided.';
  if (r.decision === 'part') {
    if (!Number.isFinite(r.amount) || !(r.amount > 0)) return 'Say how much to deduct.';
    if (r.amount >= (c.amount || 0)) return 'That is all of it. Recommend Deduct instead.';
  }
  if (r.decision === 'putback' && c.answer !== 'putback') return 'Only when they have offered to put it back.';
  if (r.note.trim().length < 3) return 'Say why, so whoever confirms it knows.';
  return null;
}

/** The recommendation on a charge, if there is one waiting. */
export function recommendationOf(c: CountCharge): Recommendation & { by: string; at: string } | null {
  if (c.decision !== 'pending' || !c.recommended_decision) return null;
  return {
    decision: c.recommended_decision,
    amount: c.recommended_amount ?? 0,
    note: c.recommended_note ?? '',
    by: c.recommended_name ?? 'The auditor',
    at: c.recommended_at ?? '',
  };
}

/** "Waive GH₵35.00", "Deduct GH₵20.00 of GH₵74.00": a recommendation as a button would say it. */
export function recommendationWords(
  c: Pick<CountCharge, 'amount'>,
  r: Pick<Recommendation, 'decision' | 'amount'>,
  money: (n: number) => string,
): string {
  switch (r.decision) {
    case 'deduct': return `Deduct ${money(c.amount)}`;
    case 'part': return `Deduct ${money(r.amount)} of ${money(c.amount)}`;
    case 'waived': return `Waive ${money(c.amount)}`;
    case 'putback': return `Let them put back ${money(c.amount)}`;
  }
  return 'A decision';
}
