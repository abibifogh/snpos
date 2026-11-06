/**
 * Bar count differences on somebody's account, not final, run the way the
 * function runs them: a count's notice lands, the person answers, a manager
 * decides or the clock does, a put-back goes into a drawer, and HIVE takes
 * the final deductions. A small fake database; every name is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  raiseCountCharge, applyReply, sweepCountCharges, settlePutbacks, writtenBy, sellingPricePerUnit,
} from './src/count-charges.js';
import { handleHive, deductionsFor, staffOf } from './src/hive.js';

const Query = {
  equal: (field, value) => ({ field, value }),
  lessThan: (field, value) => ({ field, lt: value }),
  greaterThanEqual: (field, value) => ({ field, gte: value }),
  limit: () => ({}),
  cursorAfter: () => ({}),
};
const matches = (r, q) => {
  if (!q.field) return true;
  if ('lt' in q) return String(r[q.field] ?? '') < q.lt;
  if ('gte' in q) return String(r[q.field] ?? '') >= q.gte;
  return Array.isArray(q.value) ? q.value.includes(r[q.field]) : r[q.field] === q.value;
};

function world({ enabled = true } = {}) {
  let n = 0;
  const outbox = [];
  const tables = {
    feature_flags: [{ $id: 'f1', key: 'count_charges', enabled, config: JSON.stringify({ answer_hours: 24, remind_hour: 8 }) }],
    staff_profiles: [
      { $id: 'p-regina', user_id: 'u-regina', display_name: 'Regina Test', email: 'regina@example.test', role: 'cashier', active: true, hive_staff_id: 'HV-0142' },
      { $id: 'p-chichi', user_id: 'u-chichi', display_name: 'Chichi Test', email: 'chichi@example.test', role: 'cashier', active: true },
      { $id: 'p-boss', user_id: 'u-boss', display_name: 'Boss Test', email: 'boss@example.test', role: 'manager', active: true },
    ],
    shifts: [
      { $id: 'mon', module: 'bar', status: 'closed', opened_by: 'u-chichi', opened_at: '2026-11-02T08:00:00.000Z', code: 'BAR-1' },
      { $id: 'tue', module: 'bar', status: 'open', opened_by: 'u-regina', opened_at: '2026-11-03T08:00:00.000Z', code: 'BAR-2' },
    ],
    ingredients: [
      { $id: 'club', name: 'Club', base_unit_cost: 800 },
      { $id: 'gin', name: 'Gin 25cl', base_unit_cost: 1_500 },
      { $id: 'malt', name: 'Malt', base_unit_cost: 600 },
    ],
    recipes: [
      { menu_item_id: 'm-club', ingredient_id: 'club', qty_per_unit: 1 },
      { menu_item_id: 'm-gin', ingredient_id: 'gin', qty_per_unit: 1 },
      { menu_item_id: 'm-malt', ingredient_id: 'malt', qty_per_unit: 1 },
    ],
    menu_items: [{ $id: 'm-club', price: 1_500 }, { $id: 'm-gin', price: 2_600 }, { $id: 'm-malt', price: 1_000 }],
    product_variants: [],
    shift_stock_checks: [],
    approval_notices: [],
    staff_charges: [],
    staff_charge_settlements: [],
    charge_replies: [],
    hive_staff: [],
  };
  const db = {
    async listDocuments(_d, table, qs = []) {
      const rows = (tables[table] ?? []).filter((r) => qs.every((q) => matches(r, q)));
      return { documents: rows, total: rows.length };
    },
    async getDocument(_d, table, id) {
      const r = (tables[table] ?? []).find((x) => x.$id === id);
      if (!r) throw new Error('Document not found');
      return r;
    },
    async createDocument(_d, table, id, data, perms) {
      const row = { $id: id, $createdAt: new Date(Date.UTC(2026, 10, 3, 12, 0, n)).toISOString(), $permissions: perms ?? [], ...data };
      (tables[table] ||= []).push(row);
      return row;
    },
    async updateDocument(_d, table, id, data) {
      const r = (tables[table] ?? []).find((x) => x.$id === id);
      if (!r) throw new Error('Document not found');
      Object.assign(r, data);
      return r;
    },
    async deleteDocument(_d, table, id) {
      tables[table] = tables[table].filter((x) => x.$id !== id);
    },
  };
  const unposted = [];
  const ctx = {
    db, DB_ID: 'snpos', Query,
    newId: () => `id${(n += 1)}`,
    readableBy: (u) => `read("user:${u}")`,
    money: (m) => `GH₵${(m / 100).toFixed(2)}`,
    timeZone: 'Africa/Accra',
    send: async (msg) => { outbox.push(msg); },
    unpostSettlement: async (row) => { unposted.push(row.$id); },
    log: () => {},
    error: () => {},
  };
  return { tables, ctx, outbox, unposted };
}

/** A bar count filed: its lines, then its notice, the way saveBarCount writes them. */
function file(w, { shift = 'tue', phase = 'close', lines, at = '2026-11-03T22:40:00.000Z' }) {
  for (const [ingredient, variance] of lines) {
    w.tables.shift_stock_checks.push({
      $id: `l-${ingredient}-${at}`, $createdAt: at, shift_id: shift, phase, ingredient_id: ingredient,
      variance_qty: variance, applied: true, module: 'bar',
    });
  }
  const notice = { $id: `n-${at}`, $createdAt: at, kind: 'count_charge', venue_id: 'main', shift_id: shift, phase, counted_by: 'u-regina' };
  w.tables.approval_notices.push(notice);
  return notice;
}

const NOW = '2026-11-03T22:41:00.000Z';

test('a closing count that comes up short goes on the closing bartender\'s account, not final', async () => {
  const w = world();
  const notice = file(w, { lines: [['club', -2], ['gin', -1], ['malt', 1]] });
  const out = await raiseCountCharge(w.ctx, notice, { now: NOW });
  assert.equal(out.ok, true);
  const [c] = w.tables.staff_charges;
  assert.equal(c.person_id, 'p-regina');
  assert.equal(c.amount, 3_000 + 2_600 - 1_000, 'selling price, the malt over set against it');
  assert.equal(c.decision, 'pending');
  assert.equal(c.answer_by, '2026-11-04T22:41:00.000Z');
  assert.deepEqual(c.$permissions, ['read("user:u-regina")'], 'readable by her, and managers by the collection');
  assert.ok(w.tables.shift_stock_checks.every((l) => l.charge_id === c.$id));
  assert.ok(w.tables.approval_notices[0].sent_at);
  // She is told it is not final; the managers are told too.
  assert.ok(w.outbox.some((m) => m.to.includes('regina@example.test') && /Not final/.test(m.subject)));
  assert.ok(w.outbox.some((m) => m.to.includes('boss@example.test')));

  // The same event twice is one charge.
  await raiseCountCharge(w.ctx, { ...notice, sent_at: '' }, { now: NOW });
  assert.equal(w.tables.staff_charges.length, 1);
});

test('an opening count that does not agree goes to whoever ran the shift before', async () => {
  const w = world();
  const notice = file(w, { phase: 'open', lines: [['club', -1]], at: '2026-11-03T08:05:00.000Z' });
  await raiseCountCharge(w.ctx, notice, { now: NOW });
  assert.equal(w.tables.staff_charges[0].person_id, 'p-chichi');
  assert.equal(w.tables.staff_charges[0].amount, 1_500);
});

test('an opening count with no shift before charges nobody, and says why', async () => {
  const w = world();
  w.tables.shifts = w.tables.shifts.filter((s) => s.$id !== 'mon');
  const notice = file(w, { phase: 'open', lines: [['club', -1]], at: '2026-11-03T08:05:00.000Z' });
  const out = await raiseCountCharge(w.ctx, notice, { now: NOW });
  assert.equal(out.ok, false);
  assert.equal(w.tables.staff_charges.length, 0);
  assert.match(w.tables.approval_notices[0].send_error, /no earlier bar shift/);
});

test('a count that only comes out over charges nobody', async () => {
  const w = world();
  await raiseCountCharge(w.ctx, file(w, { lines: [['malt', 2]] }), { now: NOW });
  assert.equal(w.tables.staff_charges.length, 0);
});

test('switched off, nothing is charged', async () => {
  const w = world({ enabled: false });
  const out = await raiseCountCharge(w.ctx, file(w, { lines: [['club', -2]] }), { now: NOW });
  assert.equal(out.skipped, 'feature off');
  assert.equal(w.tables.staff_charges.length, 0);
});

test('counted out twice: the second filing is charged for its own lines only', async () => {
  const w = world();
  await raiseCountCharge(w.ctx, file(w, { lines: [['club', -2]], at: '2026-11-03T22:40:00.000Z' }), { now: NOW });
  await raiseCountCharge(w.ctx, file(w, { lines: [['gin', -1]], at: '2026-11-03T22:50:00.000Z' }), { now: NOW });
  assert.deepEqual(w.tables.staff_charges.map((c) => c.amount), [3_000, 2_600]);
});

const reply = (w, row) => {
  const r = { $id: `r${w.tables.charge_replies.length}`, $permissions: [], ...row };
  w.tables.charge_replies.push(r);
  return r;
};

async function raised() {
  const w = world();
  await raiseCountCharge(w.ctx, file(w, { lines: [['club', -2], ['gin', -1]] }), { now: NOW });
  return { w, c: w.tables.staff_charges[0] };
}

test('she answers, and can change her answer until a manager decides', async () => {
  const { w, c } = await raised();
  await applyReply(w.ctx, reply(w, { charge_id: c.$id, kind: 'answer', answer: 'explain', note: 'One broke during service.', by_profile: 'p-regina' }), { now: NOW });
  assert.equal(c.answer, 'explain');
  assert.equal(c.answer_note, 'One broke during service.');
  await applyReply(w.ctx, reply(w, { charge_id: c.$id, kind: 'answer', answer: 'putback', by_profile: 'p-regina' }), { now: NOW });
  assert.equal(c.answer, 'putback');
  // Somebody else cannot answer for her.
  const r = reply(w, { charge_id: c.$id, kind: 'answer', answer: 'accept', by_profile: 'p-chichi' });
  await applyReply(w.ctx, r, { now: NOW });
  assert.match(r.error, /Only Regina Test/);
  assert.equal(c.answer, 'putback');
});

test('a decision is only taken from a manager the row proves it came from', async () => {
  const { w, c } = await raised();
  // Claims to be the manager, written by somebody else's account.
  const forged = reply(w, { charge_id: c.$id, kind: 'decide', decision: 'waived', note: 'Fine', by_user: 'u-boss', $permissions: ['read("user:u-regina")'] });
  await applyReply(w.ctx, forged, { now: NOW });
  assert.match(forged.error, /could not be confirmed/);
  // Proven, but a bartender.
  const own = reply(w, { charge_id: c.$id, kind: 'decide', decision: 'waived', note: 'Fine', by_user: 'u-regina', $permissions: ['read("user:u-regina")'] });
  await applyReply(w.ctx, own, { now: NOW });
  assert.match(own.error, /admin or a manager/);
  assert.equal(c.decision, 'pending');
  assert.equal(writtenBy({ $permissions: ['read("user:u-boss")'] }, 'u-boss'), true);
});

test('deduct part: that much from pay, the rest written off, and undone until HIVE has it', async () => {
  const { w, c } = await raised();
  const boss = { by_user: 'u-boss', $permissions: ['read("user:u-boss")'] };
  await applyReply(w.ctx, reply(w, { charge_id: c.$id, kind: 'decide', decision: 'part', amount: 3_000, note: 'One was a breakage.', ...boss }), { now: NOW });
  assert.equal(c.decision, 'part');
  assert.equal(c.decided_amount, 3_000);
  assert.equal(c.decided_name, 'Boss Test');
  assert.equal(c.status, 'settled');
  assert.deepEqual(w.tables.staff_charge_settlements.map((s) => [s.kind, s.amount]), [['pay', 3_000], ['written_off', 2_600]]);

  await applyReply(w.ctx, reply(w, { charge_id: c.$id, kind: 'undo', ...boss }), { now: NOW });
  assert.equal(c.decision, 'pending');
  assert.equal(c.status, 'open');
  assert.equal(c.settled_total, 0);
  assert.equal(c.reopened_by, 'u-boss');
  assert.equal(w.tables.staff_charge_settlements.length, 0);
  assert.equal(w.unposted.length, 2, 'both entries come off the books');

  // Decided again, then HIVE takes it: no undo after that.
  await applyReply(w.ctx, reply(w, { charge_id: c.$id, kind: 'decide', decision: 'deduct', ...boss }), { now: NOW });
  c.hive_sent_at = NOW;
  const late = reply(w, { charge_id: c.$id, kind: 'undo', ...boss });
  await applyReply(w.ctx, late, { now: NOW });
  assert.match(late.error, /gone to HIVE/);
});

test('the clock: accepted or unanswered is deducted, explained waits and the managers are reminded each morning', async () => {
  const w = world();
  await raiseCountCharge(w.ctx, file(w, { lines: [['club', -2]], at: '2026-11-03T22:40:00.000Z' }), { now: NOW });
  await raiseCountCharge(w.ctx, file(w, { lines: [['gin', -1]], at: '2026-11-03T22:50:00.000Z' }), { now: NOW });
  const [silent, explained] = w.tables.staff_charges;
  explained.answer = 'explain';
  explained.answer_note = 'The delivery was short.';
  w.outbox.length = 0;

  const early = await sweepCountCharges(w.ctx, { now: '2026-11-04T10:00:00.000Z', settings: { timezone: 'Africa/Accra' } });
  assert.equal(early.deducted, 0, 'not yet');

  const next = await sweepCountCharges(w.ctx, { now: '2026-11-05T09:00:00.000Z', settings: { timezone: 'Africa/Accra' } });
  assert.equal(next.deducted, 1);
  assert.equal(silent.decision, 'deduct');
  assert.equal(silent.decided_name, 'No answer by the deadline');
  assert.equal(explained.decision, 'pending');
  assert.equal(next.reminded, 1);
  assert.ok(w.outbox.some((m) => m.to.includes('boss@example.test') && /waiting for you to decide/.test(m.subject)));

  const again = await sweepCountCharges(w.ctx, { now: '2026-11-05T10:00:00.000Z', settings: { timezone: 'Africa/Accra' } });
  assert.equal(again.reminded, 0, 'once a morning');
});

test('put back: agreed, then settled as paid back when the next drawer closes', async () => {
  const { w, c } = await raised();
  c.answer = 'putback';
  const boss = { by_user: 'u-boss', $permissions: ['read("user:u-boss")'] };
  await applyReply(w.ctx, reply(w, { charge_id: c.$id, kind: 'decide', decision: 'putback', ...boss }), { now: NOW });
  assert.equal(c.decision, 'putback');
  assert.equal(c.status, 'open', 'nothing settled until the drawer has it');

  const thu = { $id: 'thu', code: 'BAR-4', status: 'closed', closed_by: 'u-regina', putbacks: JSON.stringify([{ charge_id: c.$id, amount: c.amount, method_id: 'cash' }]) };
  w.tables.shifts.push(thu);
  await settlePutbacks(w.ctx, thu, { now: NOW });
  assert.equal(c.status, 'settled');
  assert.equal(c.putback_shift_id, 'thu');
  const [s] = w.tables.staff_charge_settlements;
  assert.deepEqual([s.kind, s.amount, s.shift_id, s.method_id], ['cash', 5_600, 'thu', 'cash']);
  // Twice is once.
  await settlePutbacks(w.ctx, thu, { now: NOW });
  assert.equal(w.tables.staff_charge_settlements.length, 1);
});

test('a bottle sells for what the drink that pours only it sells for', () => {
  assert.equal(sellingPricePerUnit('club', [{ menu_item_id: 'm', ingredient_id: 'club', qty_per_unit: 1 }], [{ $id: 'm', price: 1_500 }], []), 1_500);
  assert.equal(sellingPricePerUnit('gin', [
    { menu_item_id: 'cocktail', ingredient_id: 'gin', qty_per_unit: 1 },
    { menu_item_id: 'cocktail', ingredient_id: 'juice', qty_per_unit: 1 },
  ], [{ $id: 'cocktail', price: 5_000 }], []), null, 'a cocktail is not what the gin sells for');
});

/* --------------------------------------------------------------- HIVE */

const SECRET = 'shared-with-hive';
const sign = (path, text, at = Date.now()) => ({ 'x-till-at': String(at), 'x-till-sig': createHmac('sha256', SECRET).update(`till-link\n${at}\n${path}\n${text}`).digest('hex') });
const call = async (w, path, body, { secret = SECRET, headers } = {}) => {
  const text = JSON.stringify(body);
  let out;
  const res = { json: (b, status = 200) => { out = { status, body: b }; return out; } };
  await handleHive({
    req: { path, method: 'POST', bodyText: text, headers: headers ?? sign(path, text) },
    res, db: w.ctx.db, DB_ID: 'snpos', Query, newId: w.ctx.newId, env: { HIVE_SECRET: secret }, now: NOW,
  });
  return out;
};

test('HIVE: its staff list comes in, final deductions go out, and once taken they are final', async () => {
  const { w, c } = await raised();
  const boss = { by_user: 'u-boss', $permissions: ['read("user:u-boss")'] };
  await applyReply(w.ctx, reply(w, { charge_id: c.$id, kind: 'decide', decision: 'deduct', ...boss }), { now: NOW });
  // Chichi has one too, and is not matched.
  await raiseCountCharge(w.ctx, file(w, { shift: 'mon', lines: [['club', -1]], at: '2026-11-02T23:00:00.000Z' }), { now: NOW });
  const chichi = w.tables.staff_charges.find((x) => x.person_id === 'p-chichi');
  await applyReply(w.ctx, reply(w, { charge_id: chichi.$id, kind: 'decide', decision: 'deduct', ...boss }), { now: NOW });

  const staff = await call(w, '/hive/staff', { staff: [{ id: 'HV-0142', name: 'Regina Test' }, { id: 'HV-0157', name: 'Chichi Test', email: 'chichi@example.test' }, { name: 'no id' }] });
  assert.deepEqual(staff.body, { ok: true, added: 2, updated: 0 });
  assert.equal(w.tables.hive_staff.length, 2);

  const read = await call(w, '/hive/deductions', {});
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.deductions.map((d) => [d.ref, d.staff_id, d.amount]), [[`POS-${c.$id}`, 'HV-0142', 5_600]]);
  assert.deepEqual(read.body.held.map((h) => [h.name, h.amount]), [['Chichi Test', 1_500]]);

  const ack = await call(w, '/hive/ack', { refs: [`POS-${c.$id}`, 'POS-nope'] });
  assert.deepEqual(ack.body.taken, [`POS-${c.$id}`]);
  assert.deepEqual(ack.body.unknown, ['POS-nope']);
  assert.equal(c.hive_sent_at, NOW);
  assert.equal(c.hive_staff_id, 'HV-0142');
  assert.equal((await call(w, '/hive/deductions', {})).body.deductions.length, 0, 'never offered twice');
});

test('HIVE: unsigned, wrongly signed or unconnected is refused', async () => {
  const w = world();
  assert.equal((await call(w, '/hive/deductions', {}, { headers: {} })).status, 401);
  assert.equal((await call(w, '/hive/deductions', {}, { headers: sign('/hive/ack', '{}') })).status, 401);
  assert.equal((await call(w, '/hive/deductions', {}, { secret: '' })).status, 503);
  let out = null;
  const res = { json: (b, s) => { out = s; return b; } };
  assert.equal(await handleHive({ req: { path: '/approvals/list', method: 'POST', headers: {} }, res, env: { HIVE_SECRET: SECRET } }), null, 'not a HIVE path');
  assert.equal(out, null);
});

test('HIVE rows: decided only, matched only, part as decided', () => {
  const rows = [
    { $id: 'a', person_id: 'p1', person_name: 'A', amount: 1_000, decision: 'deduct', decided_at: '2026-11-03T00:00:00Z' },
    { $id: 'b', person_id: 'p1', person_name: 'A', amount: 1_000, decision: 'part', decided_amount: 400, decided_at: '2026-11-03T00:00:00Z' },
    { $id: 'c', person_id: 'p1', person_name: 'A', amount: 1_000, decision: 'pending' },
  ];
  const out = deductionsFor(rows, [{ $id: 'p1', hive_staff_id: 'H1' }]);
  assert.deepEqual(out.deductions.map((d) => [d.ref, d.amount]), [['POS-a', 1_000], ['POS-b', 400]]);
  assert.throws(() => staffOf({}), /staff/);
});
