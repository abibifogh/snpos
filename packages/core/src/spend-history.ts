/**
 * What happened to a spend after it was recorded.
 *
 * A spend could be corrected at the till, approved or refused, and nothing
 * kept a trace: the row said what it says now, and "it was GH₵400 when I
 * looked on Tuesday" had no answer. So every change is written down as it is
 * made — who, when, and each field from what to what, the shopping list
 * included — and read back here as plain lines.
 *
 * Pure. Imports nothing at runtime.
 */

/** The parts of a spend a change is judged on. */
export interface SpendSnapshot {
  amount?: number;
  category_key?: string | null;
  category?: string | null;
  payee?: string | null;
  note?: string | null;
  paid_from_method_id?: string | null;
  source?: string | null;
  imprest_float_id?: string | null;
  approval_status?: string | null;
  /** The shopping list, as it stood. */
  items?: { name: string; qty: number; line_total: number }[];
}

export interface SpendAudit {
  $id: string;
  $createdAt: string;
  action: string;
  actor_id?: string | null;
  before?: string | null;
  after?: string | null;
  reason?: string | null;
}

export interface SpendHistoryRow {
  id: string;
  at: string;
  who: string;
  what: string;
  changes: string[];
  reason?: string;
}

export const SPEND_ACTIONS = ['spend_edited', 'spend_approved', 'spend_refused'] as const;

const SOURCE_WORDS: Record<string, string> = {
  drawer: 'the drawer', box: 'a petty cash box', bank: 'the bank', own: 'their own money',
};

const itemsWords = (items: SpendSnapshot['items'], money: (n: number) => string): string =>
  !items || items.length === 0
    ? 'nothing itemised'
    : items.map((i) => `${i.qty} × ${i.name} (${money(i.line_total)})`).join(', ');

/** Each field that moved, in words. Nothing when nothing did. */
export function spendChanges(
  before: SpendSnapshot,
  after: SpendSnapshot,
  opts: { money: (n: number) => string; methodName?: (id: string) => string },
): string[] {
  const out: string[] = [];
  const said = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : String(v));
  const differ = (a: unknown, b: unknown) => said(a) !== said(b);

  if (after.amount !== undefined && before.amount !== after.amount) {
    out.push(`Amount ${opts.money(before.amount ?? 0)} → ${opts.money(after.amount)}`);
  }
  const catBefore = before.category_key || before.category;
  const catAfter = after.category_key || after.category;
  if (catAfter !== undefined && differ(catBefore, catAfter)) out.push(`Category ${said(catBefore)} → ${said(catAfter)}`);
  if (after.payee !== undefined && differ(before.payee, after.payee)) out.push(`Paid to ${said(before.payee)} → ${said(after.payee)}`);
  if (after.paid_from_method_id !== undefined && differ(before.paid_from_method_id, after.paid_from_method_id)) {
    const name = (id?: string | null) => (id ? opts.methodName?.(id) ?? id : '—');
    out.push(`Paid by ${name(before.paid_from_method_id)} → ${name(after.paid_from_method_id)}`);
  }
  if (after.source !== undefined && differ(before.source, after.source)) {
    out.push(`Came out of ${SOURCE_WORDS[before.source ?? ''] ?? said(before.source)} → ${SOURCE_WORDS[after.source ?? ''] ?? said(after.source)}`);
  }
  if (after.note !== undefined && differ(before.note, after.note)) out.push(`Note “${said(before.note)}” → “${said(after.note)}”`);
  if (after.items !== undefined && itemsWords(before.items, opts.money) !== itemsWords(after.items, opts.money)) {
    out.push(`Items ${itemsWords(before.items, opts.money)} → ${itemsWords(after.items, opts.money)}`);
  }
  return out;
}

const parse = (text?: string | null): SpendSnapshot => {
  try { return (JSON.parse(text || '{}') as SpendSnapshot) ?? {}; } catch { return {}; }
};

/**
 * The spend's story, newest first: recorded, then every change since.
 *
 * Only what was written down. Changes made before this existed left no
 * trace, and the last line says so rather than implying there were none.
 */
export function spendHistory(input: {
  spend: { $createdAt: string; $updatedAt?: string; created_by?: string | null; amount: number };
  audits: SpendAudit[];
  nameOf: (id?: string | null) => string;
  money: (n: number) => string;
  methodName?: (id: string) => string;
}): SpendHistoryRow[] {
  const rows: SpendHistoryRow[] = input.audits
    .filter((a) => (SPEND_ACTIONS as readonly string[]).includes(a.action))
    .map((a) => ({
      id: a.$id,
      at: a.$createdAt,
      who: input.nameOf(a.actor_id) || 'Somebody',
      what: a.action === 'spend_approved' ? 'Approved' : a.action === 'spend_refused' ? 'Refused' : 'Changed',
      changes: a.action === 'spend_edited'
        ? spendChanges(parse(a.before), parse(a.after), { money: input.money, methodName: input.methodName })
        : [],
      reason: a.reason || undefined,
    }));
  rows.push({
    id: 'recorded',
    at: input.spend.$createdAt,
    who: input.nameOf(input.spend.created_by) || 'Somebody',
    what: `Recorded, ${input.money(input.spend.amount)}`,
    changes: [],
  });
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

/** The fields a change to a spend is recorded by. See spend-history.ts. */
export function spendSnapshot(row: SpendSnapshot & Record<string, unknown>): SpendSnapshot {
  return {
    amount: row.amount,
    category_key: row.category_key ?? null,
    category: row.category ?? null,
    payee: row.payee ?? null,
    note: row.note ?? null,
    paid_from_method_id: row.paid_from_method_id ?? null,
    source: row.source ?? null,
    imprest_float_id: row.imprest_float_id ?? null,
    ...(row.items ? { items: row.items } : {}),
  };
}
