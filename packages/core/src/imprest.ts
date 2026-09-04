import { db, DB_ID, ID, Query, listAll, listByIds } from './client';
import type { Doc } from './types';
import { ACCOUNTS, postEntry } from './ledger';
import { boxBalance, countBox, coversFrom, spendCorrections } from './imprest-rules';
import type { ImprestMovement, ImprestKind } from './imprest-rules';
// Shaping a movement into a panel is pure and lives next door.
import type { DetailExpense, DetailNames } from './imprest-detail';

/**
 * Petty cash boxes, and the two sets of books they have to agree with.
 *
 * A box has its own record of what is in it — the movements — and it also has
 * a place on the balance sheet. Those must never be allowed to drift apart, so
 * every function here that moves money does both in one go and stores the
 * journal entry's id on the movement. Walk it from either end and the same
 * figure comes back.
 *
 * The arithmetic lives next door in imprest-rules, which imports nothing.
 */

export * from './imprest-rules';

export interface ImprestFloatDoc extends Doc {
  venue_id: string;
  name: string;
  fixed_amount: number;
  account_code?: string;
  custodian_id?: string;
  module?: string;
  note?: string;
  active?: boolean;
  sort?: number;
}

export interface ImprestMovementDoc extends Doc, ImprestMovement {
  venue_id: string;
  float_id: string;
  ref_type?: string;
  ref_id?: string;
  entry_id?: string;
  note?: string;
  created_by: string;
}

export interface ImprestCountDoc extends Doc {
  venue_id: string;
  float_id: string;
  expected: number;
  counted: number;
  variance: number;
  counted_by: string;
  counted_at?: string;
  note?: string;
  topped_up: number;
}

/** Where a box sits on the balance sheet, with the shared one as the default. */
export const accountFor = (box: Pick<ImprestFloatDoc, 'account_code'>): string =>
  box.account_code || ACCOUNTS.pettyCash;

export const loadFloats = async (venueId: string): Promise<ImprestFloatDoc[]> =>
  (await listAll<ImprestFloatDoc>('imprest_floats', [Query.equal('venue_id', venueId)]).catch(
    () => [] as ImprestFloatDoc[],
  )).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));

export const loadMovements = async (floatId: string): Promise<ImprestMovementDoc[]> =>
  (await listAll<ImprestMovementDoc>('imprest_movements', [Query.equal('float_id', floatId)]).catch(
    () => [] as ImprestMovementDoc[],
  )).sort((a, b) => (b.occurred_at ?? b.$createdAt).localeCompare(a.occurred_at ?? a.$createdAt));

export const loadCounts = async (floatId: string): Promise<ImprestCountDoc[]> =>
  (await listAll<ImprestCountDoc>('imprest_counts', [Query.equal('float_id', floatId)]).catch(
    () => [] as ImprestCountDoc[],
  )).sort((a, b) => (b.counted_at ?? b.$createdAt).localeCompare(a.counted_at ?? a.$createdAt));

/**
 * Every box's balance in one pass.
 *
 * One read of the movements rather than one per box. A business with four
 * boxes and a year of history behind them would otherwise make four full
 * reads to draw a list that fits on half a screen — the exact greed that put
 * the tills on the floor when the month's allowance ran out.
 */
export async function balancesFor(floats: ImprestFloatDoc[]): Promise<Record<string, number>> {
  if (floats.length === 0) return {};
  const ids = floats.map((f) => f.$id);
  const rows = await listAll<ImprestMovementDoc>('imprest_movements', [
    Query.equal('float_id', ids),
  ]).catch(() => [] as ImprestMovementDoc[]);

  const out: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const m of rows) out[m.float_id] = (out[m.float_id] ?? 0) + m.amount;
  return out;
}

/**
 * One box's balance.
 *
 * Named for the box rather than "balanceOf", which a consignor's ledger owns
 * already. Two exports with one name in a package everything imports from is a
 * collision waiting for whichever file is compiled second.
 */
export const floatBalance = async (floatId: string): Promise<number> =>
  boxBalance(await loadMovements(floatId));

/**
 * Write a movement and the entry that goes with it.
 *
 * The posting FIRST, then the movement that points at it. The other order
 * leaves a box that says money moved and books that never heard about it,
 * which is the harder of the two to notice — a box short of a movement is
 * visible the moment somebody counts it, and a ledger short of an entry is
 * visible to nobody until an accountant asks.
 */
async function moveMoney(opts: {
  venueId: string;
  box: ImprestFloatDoc;
  /** Signed. Positive into the box, negative out of it. */
  amount: number;
  kind: ImprestKind;
  /** The other side of the entry. What the money came from, or went to. */
  againstAccount: string;
  memo: string;
  userId: string;
  refType?: string;
  refId?: string;
  note?: string;
  date?: Date;
}): Promise<ImprestMovementDoc> {
  const box = accountFor(opts.box);
  const size = Math.abs(opts.amount);
  const into = opts.amount > 0;

  let entryId = '';
  if (size > 0) {
    const entry = await postEntry(
      opts.venueId,
      {
        date: opts.date,
        /*
          'adjustment', not 'imprest'.

          `journal_entries.source` is a fixed list and does not have a value
          for this — writing one Appwrite has never heard of is refused whole,
          which is exactly what topping a box up did: "Attribute source has
          invalid format". An enum cannot be widened without provisioning the
          database again, and a feature that only works after somebody runs a
          workflow is a feature that does not work.

          Nothing reads `source` to find these; what identifies them is the
          source id below, which carries the box and what happened to it.
        */
        source: 'adjustment',
        sourceId: `imprest:${opts.refType ?? 'move'}:${opts.refId || opts.box.$id}`,
        memo: opts.memo,
        postedBy: opts.userId,
      },
      into
        // Money into the box: the box holds more, the safe holds less.
        ? [
            { account_code: box, debit: size, credit: 0, memo: opts.memo },
            { account_code: opts.againstAccount, debit: 0, credit: size, memo: opts.memo },
          ]
        : [
            { account_code: opts.againstAccount, debit: size, credit: 0, memo: opts.memo },
            { account_code: box, debit: 0, credit: size, memo: opts.memo },
          ],
    );
    entryId = entry.$id;
  }

  return (await db.createDocument(DB_ID, 'imprest_movements', ID.unique(), {
    venue_id: opts.venueId,
    float_id: opts.box.$id,
    amount: opts.amount,
    kind: opts.kind,
    ref_type: opts.refType ?? '',
    ref_id: opts.refId ?? '',
    entry_id: entryId,
    note: (opts.note ?? '').slice(0, 500),
    created_by: opts.userId,
    occurred_at: (opts.date ?? new Date()).toISOString(),
  })) as unknown as ImprestMovementDoc;
}

/**
 * Put money into the box.
 *
 * Establishing a box and topping one up are the same act and are not told
 * apart: the first top-up IS the establishment, and having two words for it
 * only creates a way to get the first one wrong.
 *
 * `fromAccount` is where the money came from — the till's cash by default,
 * a bank account when somebody drew it out. Recorded rather than assumed,
 * because "the petty cash went up by 500 and nothing went down" is an entry
 * that does not balance and cannot be posted at all.
 */
export async function topUpFloat(opts: {
  venueId: string;
  box: ImprestFloatDoc;
  amount: number;
  userId: string;
  fromAccount?: string;
  note?: string;
  date?: Date;
}): Promise<ImprestMovementDoc> {
  if (opts.amount <= 0) throw new Error('Enter how much went into the box.');
  return moveMoney({
    venueId: opts.venueId,
    box: opts.box,
    amount: opts.amount,
    kind: 'top_up',
    againstAccount: opts.fromAccount || ACCOUNTS.cash,
    memo: `Topped up ${opts.box.name}`,
    userId: opts.userId,
    refType: 'top_up',
    note: opts.note,
    date: opts.date,
  });
}

/** And take it back out, when a box is being wound down or is simply too full. */
export async function returnFromFloat(opts: {
  venueId: string;
  box: ImprestFloatDoc;
  amount: number;
  userId: string;
  toAccount?: string;
  note?: string;
}): Promise<ImprestMovementDoc> {
  if (opts.amount <= 0) throw new Error('Enter how much came out of the box.');
  return moveMoney({
    venueId: opts.venueId,
    box: opts.box,
    amount: -opts.amount,
    kind: 'return',
    againstAccount: opts.toAccount || ACCOUNTS.cash,
    memo: `Returned from ${opts.box.name}`,
    userId: opts.userId,
    refType: 'return',
    note: opts.note,
  });
}

/**
 * Record that money left a box.
 *
 * The movement only — the expense row, its posting, its receipt and anything
 * it put on a shelf are the expense form's job, and that form is the same one
 * a spend from a drawer goes through. This is the single line that says the
 * tin is lighter, kept here rather than written inline wherever a spend
 * happens, so there is one place that decides what a spend out of a box looks
 * like.
 *
 * There used to be a whole second implementation beside it — a headless
 * `spendFromFloat` that wrote its own expense, posted its own entry and moved
 * the box. Two ways to spend from a tin is two ways for them to drift, and the
 * shelf is the one thing that cannot survive two opinions about how a purchase
 * reaches it.
 */
export async function recordBoxSpend(opts: {
  venueId: string;
  boxId: string;
  amount: number;
  userId: string;
  /** The expense this came from, so the receipt can be found from either end. */
  expenseId: string;
  /** The journal entry it posted, when one was made. */
  entryId?: string;
  note?: string;
}): Promise<ImprestMovementDoc> {
  return (await db.createDocument(DB_ID, 'imprest_movements', ID.unique(), {
    venue_id: opts.venueId,
    float_id: opts.boxId,
    // Negative: out of the box. See boxBalance — the balance is the sum of
    // these and is never stored anywhere.
    amount: -Math.abs(opts.amount),
    kind: 'spend',
    ref_type: 'expense',
    ref_id: opts.expenseId,
    entry_id: opts.entryId ?? '',
    note: (opts.note ?? '').slice(0, 500),
    created_by: opts.userId,
    occurred_at: new Date().toISOString(),
  })) as unknown as ImprestMovementDoc;
}

/**
 * Make a box's record agree with what an expense now says.
 *
 * The till records a spend once and never touches it again, which is why
 * `recordBoxSpend` above is all it needs. An admin correcting an expense
 * afterwards is the other case, and everything a box cares about can change:
 * the amount, which box paid for it, or whether it came out of a box at all.
 *
 * None of that follows on its own. A movement is a statement that money moved
 * on a day, and the ones already written stay written — so the difference is
 * worked out and recorded as its own movement. See spendCorrections, where the
 * arithmetic lives and is tested; this does the reading and the writing.
 *
 * Safe to call on every save, including the ones that changed nothing about
 * the money: with no difference to correct, it writes nothing at all.
 */
export async function settleBoxSpend(opts: {
  venueId: string;
  expenseId: string;
  /** The box it is now paid from, or null if it is no longer a box spend. */
  boxId: string | null;
  amount: number;
  userId: string;
  note?: string;
  entryId?: string;
}): Promise<{ written: number }> {
  const movements = await listAll<ImprestMovementDoc>('imprest_movements', [
    Query.equal('ref_type', 'expense'),
    Query.equal('ref_id', opts.expenseId),
  ]).catch(() => [] as ImprestMovementDoc[]);

  const corrections = spendCorrections(movements, { boxId: opts.boxId, amount: opts.amount });

  let written = 0;
  for (const c of corrections) {
    const done = await db.createDocument(DB_ID, 'imprest_movements', ID.unique(), {
      venue_id: opts.venueId,
      float_id: c.floatId,
      amount: c.amount,
      kind: c.kind,
      ref_type: 'expense',
      ref_id: opts.expenseId,
      entry_id: opts.entryId ?? '',
      note: (c.kind === 'adjust'
        ? `Corrected: ${opts.note ?? 'the expense was changed'}`
        : (opts.note ?? '')).slice(0, 500),
      created_by: opts.userId,
      occurred_at: new Date().toISOString(),
    }).then(() => true).catch(() => false);
    if (done) written += 1;
  }

  return { written };
}

/**
 * Count the box, and settle whatever the count found.
 *
 * The count is written whether or not anything was wrong with it, because "we
 * counted it and it was right" is a fact worth being able to show. A record
 * that only exists when money was missing makes every row in it read as an
 * accusation, and boxes stop being counted.
 *
 * A difference is posted to cash over/short exactly as a drawer's is. It is
 * the same event — money that should be somewhere and is not — and filing it
 * anywhere else would keep petty cash losses out of the one figure an owner
 * looks at to find them.
 *
 * The top-up, if one is being made at the same sitting, happens AFTER the
 * adjustment. The other order tops the box up to its level and then books a
 * shortage against the money that was just put in, which is arithmetically the
 * same and tells the wrong story about which money went missing.
 */
export async function reconcileFloat(opts: {
  venueId: string;
  box: ImprestFloatDoc;
  counted: number;
  userId: string;
  note?: string;
  /** Restore the box to its fixed amount at the same time. */
  topUp?: boolean;
  topUpFrom?: string;
}): Promise<{ variance: number; toppedUp: number; countId: string }> {
  const balance = boxBalance(await loadMovements(opts.box.$id));
  const result = countBox({ fixedAmount: opts.box.fixed_amount, balance, counted: opts.counted });

  /*
    Where this count's window starts, read BEFORE anything is written.

    The adjustment and the restoring top-up below both happen as part of
    settling this count and belong inside its window — so the start has to be
    taken from the previous count, now, rather than worked out afterwards from
    a list this function is about to add to.
  */
  const from = coversFrom(await loadCounts(opts.box.$id));

  if (result.variance !== 0) {
    await moveMoney({
      venueId: opts.venueId,
      box: opts.box,
      amount: result.variance,
      kind: 'adjust',
      // The same account a drawer's shortage goes to. A loss is a loss
      // wherever the money was sitting.
      againstAccount: ACCOUNTS.cashOverShort,
      memo: result.variance < 0
        ? `${opts.box.name} short at count`
        : `${opts.box.name} over at count`,
      userId: opts.userId,
      refType: 'count',
      note: opts.note,
    });
  }

  let toppedUp = 0;
  if (opts.topUp && result.toRestore > 0) {
    await topUpFloat({
      venueId: opts.venueId,
      box: opts.box,
      amount: result.toRestore,
      userId: opts.userId,
      fromAccount: opts.topUpFrom,
      note: 'Restored to its level after counting',
    });
    toppedUp = result.toRestore;
  }

  const count = await db.createDocument(DB_ID, 'imprest_counts', ID.unique(), {
    venue_id: opts.venueId,
    float_id: opts.box.$id,
    expected: result.expected,
    counted: result.counted,
    variance: result.variance,
    counted_by: opts.userId,
    counted_at: new Date().toISOString(),
    covers_from: from || null,
    note: (opts.note ?? '').slice(0, 500),
    topped_up: toppedUp,
  });

  return { variance: result.variance, toppedUp, countId: count.$id };
}

/* ------------------------------------------- what one line in a box actually was */

/**
 * Everything behind one movement, ready for a panel.
 *
 * Read on demand rather than loaded with the list. A box has hundreds of
 * movements and one of them is being looked at; fetching every expense, every
 * supplier and every shift to draw a table that shows none of them is how a
 * screen that opens instantly becomes one people wait for.
 *
 * Names are looked up by id rather than snapshotted here, so the panel shows a
 * supplier's current name. The shaping is in imprest-detail, which has no
 * database in it.
 */
export async function loadMovementDetail(
  movement: Pick<ImprestMovementDoc, '$id' | 'kind' | 'ref_id' | 'created_by'>,
): Promise<{ expense: DetailExpense | null; names: DetailNames }> {
  const names: DetailNames = { people: {}, suppliers: {}, categories: {}, shifts: {} };

  const expense = movement.kind === 'spend' && movement.ref_id
    ? await db.getDocument(DB_ID, 'shift_expenses', movement.ref_id)
      .then((d) => d as unknown as DetailExpense)
      .catch(() => null)
    : null;

  /*
    Only the rows this panel actually names.

    Reading every member of staff and every supplier to show one of each is the
    same waste as loading the expenses with the list, and it is the reason
    detail panels get built to show ids instead.
  */
  const peopleIds = [movement.created_by, expense?.created_by, expense?.approved_by, expense?.paid_to_staff_id]
    .filter((x): x is string => !!x);
  if (peopleIds.length > 0) {
    const staff = await listByIds<{ $id: string; display_name?: string }>(
      'staff_profiles', '$id', peopleIds,
    ).catch(() => []);
    for (const s of staff) names.people[s.$id] = s.display_name || 'Somebody with no name set';
  }

  if (expense?.supplier_id) {
    const s = await db.getDocument(DB_ID, 'suppliers', expense.supplier_id)
      .then((d) => d as unknown as { $id: string; name?: string })
      .catch(() => null);
    if (s?.name) names.suppliers[s.$id] = s.name;
  }

  if (expense?.category_key) {
    const c = await listAll<{ $id: string; key?: string; name?: string }>('expense_categories', [
      Query.equal('key', expense.category_key), Query.limit(1),
    ]).catch(() => []);
    if (c[0]?.name) names.categories[expense.category_key] = c[0].name;
  }

  if (expense?.shift_id) {
    const sh = await db.getDocument(DB_ID, 'shifts', expense.shift_id)
      .then((d) => d as unknown as { $id: string; code?: string; opened_at?: string })
      .catch(() => null);
    if (sh) {
      names.shifts[sh.$id] = sh.code
        || (sh.opened_at ? new Date(sh.opened_at).toLocaleDateString() : 'A shift with no name');
    }
  }

  return { expense, names };
}
