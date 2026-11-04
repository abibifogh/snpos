import { db, DB_ID, ID, Query, Permission, Role, account, listAll, saveDropping } from './client';
import { putbacksDue } from './count-charges';
import type { CountCharge, CountAnswer, CountDecision, HiveStaff, Putback } from './count-charges';
import type { Shift, PaymentMethod } from './shifts';

/**
 * Reading count differences, and saying something about one.
 *
 * Nothing here writes a charge. Nobody below an admin may, and a bartender
 * must not be able to edit what they owe: so an answer, a decision or an undo
 * is written as a charge_replies row, and the server checks it and makes the
 * change. See functions/notify/src/count-charges.js. The rules are in
 * count-charges.ts.
 */

/** Every count difference on the business, newest first. Managers only. */
export const loadCountCharges = (venueId: string): Promise<CountCharge[]> =>
  listAll<CountCharge>('staff_charges', [
    Query.equal('venue_id', venueId),
    Query.equal('decision', ['pending', 'deduct', 'part', 'waived', 'putback']),
  ]).then((rows) => rows.sort((a, b) => b.charged_at.localeCompare(a.charged_at)));

/** The account this device is signed in with: who a row can prove it came from. */
const signedIn = async (): Promise<string> => (await account.get().catch(() => null))?.$id ?? '';

export interface ReplyResult { ok: boolean; error?: string; replyId: string }

/**
 * Wait for the server to act on a reply. It normally takes a second or two;
 * after the wait, the screen says it is on its way rather than that it failed.
 */
async function settled(replyId: string, waitMs: number): Promise<ReplyResult> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 700));
    const row = await db.getDocument(DB_ID, 'charge_replies', replyId).catch(() => null) as
      { done_at?: string | null; error?: string | null } | null;
    if (row?.done_at) return row.error ? { ok: false, error: row.error, replyId } : { ok: true, replyId };
  }
  return { ok: true, replyId };
}

async function reply(data: Record<string, unknown>, waitMs = 12_000): Promise<ReplyResult> {
  const me = await signedIn();
  /*
    Readable by the account that wrote it, which only that account can grant:
    it is how the server knows who decided.
  */
  const row = await db.createDocument(DB_ID, 'charge_replies', ID.unique(), { ...data, by_user: data.by_user || me },
    me ? [Permission.read(Role.user(me))] : []).catch((e: unknown) => {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(/could not be found|not found/i.test(why)
      ? 'This needs a database update before it can be used. Ask an admin to run it.'
      : why);
  });
  return settled(row.$id, waitMs);
}

/** The person's own answer, from the till. They can change it until a manager decides. */
export const answerCountCharge = (opts: {
  venueId: string; chargeId: string; answer: CountAnswer; note: string; profileId: string; name: string;
}): Promise<ReplyResult> => reply({
  venue_id: opts.venueId,
  charge_id: opts.chargeId,
  kind: 'answer',
  answer: opts.answer,
  note: opts.note.trim().slice(0, 1000),
  by_profile: opts.profileId,
  by_name: opts.name.slice(0, 120),
});

/** A manager's decision. Taken only from an admin or a manager signed in as themselves. */
export const decideCountCharge = (opts: {
  venueId: string; chargeId: string; decision: Exclude<CountDecision, 'pending'>; amount?: number; note?: string;
  profileId: string; name: string;
}): Promise<ReplyResult> => reply({
  venue_id: opts.venueId,
  charge_id: opts.chargeId,
  kind: 'decide',
  decision: opts.decision,
  amount: Math.round(opts.amount ?? 0),
  note: (opts.note ?? '').trim().slice(0, 1000),
  by_profile: opts.profileId,
  by_name: opts.name.slice(0, 120),
  by_user: '',
});

/** Take a decision back, until it has gone to HIVE. */
export const undoCountCharge = (opts: { venueId: string; chargeId: string; profileId: string; name: string }): Promise<ReplyResult> =>
  reply({
    venue_id: opts.venueId,
    charge_id: opts.chargeId,
    kind: 'undo',
    by_profile: opts.profileId,
    by_name: opts.name.slice(0, 120),
    by_user: '',
  });

/**
 * What to add to this drawer at close: count differences the person running
 * the shift, or the person closing it, agreed to put back. Read as whoever is
 * signed in, so a till that cannot read them adds nothing, rather than
 * expecting money nobody was asked for.
 */
export async function putbacksForClose(
  shift: Pick<Shift, 'opened_by'>,
  closerId: string,
  methods: PaymentMethod[],
): Promise<{ putbacks: Putback[]; charges: CountCharge[] }> {
  const cash = methods.find((m) => m.kind === 'cash' && m.counted_at_close);
  if (!cash) return { putbacks: [], charges: [] };
  const people = [...new Set([shift.opened_by, closerId].filter(Boolean))];
  const rows = (await Promise.all(people.map((id) => listAll<CountCharge>('staff_charges', [
    Query.equal('person_user_id', id), Query.equal('decision', 'putback'),
  ]).catch(() => [] as CountCharge[])))).flat();
  const seen = new Set<string>();
  const charges = people
    .flatMap((id) => putbacksDue(rows, { userId: id }))
    .filter((c) => (seen.has(c.$id) ? false : (seen.add(c.$id), true)));
  return {
    charges,
    putbacks: charges.map((c) => ({ charge_id: c.$id, amount: Math.max(0, c.amount - (c.settled_total || 0)), method_id: cash.$id })),
  };
}

/* --------------------------------------------------------------- HIVE */

/** HIVE's own staff list, as HIVE last sent it. Empty until HIVE is connected. */
export const loadHiveStaff = (): Promise<HiveStaff[]> =>
  listAll<HiveStaff>('hive_staff').then((rows) => rows.sort((a, b) => a.name.localeCompare(b.name))).catch(() => []);

/** Match a person on the POS to a HIVE staff record, or clear the match. */
export async function setHiveMatch(profileId: string, hive: { id: string; name: string } | null): Promise<void> {
  const { dropped } = await saveDropping('staff_profiles', profileId, {
    hive_staff_id: hive?.id.trim().slice(0, 64) ?? '',
    hive_name: hive?.name.trim().slice(0, 160) ?? '',
  });
  if (dropped.length) throw new Error('The database has not been given the HIVE fields yet. Ask an admin to update it.');
}

/**
 * Mark deductions as taken by HIVE, after the spreadsheet was imported there
 * by hand. Admins only. Final from then on: nobody can take them back.
 */
export async function markSentToHive(rows: { chargeId: string; hiveStaffId: string }[]): Promise<number> {
  const when = new Date().toISOString();
  let done = 0;
  for (const r of rows) {
    await db.updateDocument(DB_ID, 'staff_charges', r.chargeId, { hive_sent_at: when, hive_staff_id: r.hiveStaffId });
    done += 1;
  }
  return done;
}

