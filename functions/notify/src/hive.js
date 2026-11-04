/**
 * HIVE, the payroll, and the POS: three signed paths.
 *
 *   /hive/staff       HIVE sends its staff list, so an admin can match each
 *                     person on the POS to their HIVE record by choosing it on
 *                     Staff rather than typing a number.
 *   /hive/deductions  HIVE reads the final count-difference deductions not yet
 *                     taken: one row each, named by the HIVE staff member the
 *                     person is matched to, with its own reference.
 *   /hive/ack         HIVE says which of those it has taken. They are final
 *                     from then on: nobody here can take the decision back,
 *                     and they are never offered again.
 *
 * A person nobody has matched is never guessed at. Their deductions are held
 * and listed as held, so HIVE (and Staff owing) can say who needs matching.
 *
 * SIGNED the way the group hub signs its paths (see insight-approvals.js):
 * X-Till-At and X-Till-Sig, HMAC-SHA256 over "till-link", the time, the path
 * and the body, within five minutes. The secret is HIVE_SECRET, set on this
 * function. Without it the paths answer that HIVE is not connected.
 */
import { signedByHub } from './insight-approvals.js';

const PATHS = new Set(['/hive/staff', '/hive/deductions', '/hive/ack']);
const ref = (chargeId) => `POS-${chargeId}`;
const unref = (r) => (String(r || '').startsWith('POS-') ? String(r).slice(4) : '');

async function listAll(ctx, table, queries = []) {
  const { db, DB_ID, Query } = ctx;
  const out = [];
  let cursor = null;
  for (let page = 0; page < 50; page += 1) {
    const q = [...queries, Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])];
    const { documents } = await db.listDocuments(DB_ID, table, q);
    out.push(...documents);
    if (documents.length < 100) break;
    cursor = documents[documents.length - 1].$id;
  }
  return out;
}

/** What is taken from pay for a decided charge. */
export const takenFromPay = (c) => (c.decision === 'deduct' ? (c.amount || 0)
  : c.decision === 'part' ? Math.max(0, Math.min(c.amount || 0, c.decided_amount || 0)) : 0);

/** The final deductions, split into what HIVE can take and what is held. */
export function deductionsFor(charges, profiles, { includeSent = false, since = '', currency = 'GHS' } = {}) {
  const deductions = [];
  const held = new Map();
  for (const c of charges) {
    const amount = takenFromPay(c);
    if (!(amount > 0)) continue;
    if (c.hive_sent_at && !includeSent) continue;
    const when = c.decided_at || c.charged_at || '';
    if (since && when.slice(0, 10) < since) continue;
    const p = profiles.find((x) => x.$id === c.person_id);
    const staffId = c.hive_staff_id || p?.hive_staff_id || '';
    if (!staffId) {
      const h = held.get(c.person_id) ?? { name: c.person_name, amount: 0, count: 0, reason: 'not matched to a HIVE staff record' };
      h.amount += amount;
      h.count += 1;
      held.set(c.person_id, h);
      continue;
    }
    deductions.push({
      ref: ref(c.$id),
      staff_id: staffId,
      name: c.person_name,
      amount,
      currency,
      date: when.slice(0, 10),
      description: `Bar count difference${c.phase === 'open' ? ' (counted in)' : c.phase === 'close' ? ' (counted out)' : ''}${c.decision === 'part' ? ', part' : ''}`,
      decided_by: c.decided_name || '',
      ...(c.hive_sent_at ? { sent_at: c.hive_sent_at } : {}),
    });
  }
  deductions.sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  return { deductions, held: [...held.values()] };
}

/** HIVE's staff list, cleaned: id and name required. */
export function staffOf(body) {
  const rows = Array.isArray(body?.staff) ? body.staff : null;
  if (!rows) throw Object.assign(new Error('Send { staff: [{ id, name, email }] }.'), { status: 400 });
  if (rows.length > 2000) throw Object.assign(new Error('That is more staff than one request can carry.'), { status: 400 });
  return rows
    .map((r) => ({
      hive_id: String(r?.id ?? '').trim().slice(0, 64),
      name: String(r?.name ?? '').trim().slice(0, 160),
      email: String(r?.email ?? '').trim().toLowerCase().slice(0, 160),
      role: String(r?.role ?? '').trim().slice(0, 80),
      active: r?.active !== false,
    }))
    .filter((r) => r.hive_id && r.name);
}

export async function handleHive({ req, res, db, DB_ID, Query, newId, log, error, env = process.env, now }) {
  const path = String(req.path || '/').replace(/\/+$/, '') || '/';
  if (!PATHS.has(path)) return null;
  const send = (body, status = 200) => res.json(body, status);
  if (String(req.method || '').toUpperCase() !== 'POST') return send({ ok: false, error: 'POST only.' }, 405);
  const secret = env.HIVE_SECRET || '';
  if (!secret) return send({ ok: false, error: 'This POS is not connected to HIVE: HIVE_SECRET is not set.' }, 503);
  const bodyText = typeof req.bodyText === 'string' ? req.bodyText : typeof req.body === 'string' ? req.body : JSON.stringify(req.bodyJson ?? {});
  const header = (name) => req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  if (!signedByHub(secret, { at: header('x-till-at'), sig: header('x-till-sig'), path, bodyText })) {
    return send({ ok: false, error: 'That request did not come from HIVE.' }, 401);
  }
  let body;
  try { body = JSON.parse(bodyText || '{}'); } catch { return send({ ok: false, error: 'That was not JSON.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return send({ ok: false, error: 'That was not a JSON object.' }, 400);
  const ctx = { db, DB_ID, Query };
  const stamp = now || new Date().toISOString();

  try {
    if (path === '/hive/staff') {
      const staff = staffOf(body);
      const have = await listAll(ctx, 'hive_staff').catch(() => []);
      let added = 0;
      let changed = 0;
      for (const s of staff) {
        const row = have.find((h) => h.hive_id === s.hive_id);
        if (row) {
          await db.updateDocument(DB_ID, 'hive_staff', row.$id, { ...s, seen_at: stamp });
          changed += 1;
        } else {
          await db.createDocument(DB_ID, 'hive_staff', newId(), { ...s, seen_at: stamp });
          added += 1;
        }
      }
      // Gone from HIVE's list: kept, so a match made to them still reads, but no longer offered.
      const sent = new Set(staff.map((s) => s.hive_id));
      for (const h of have.filter((x) => !sent.has(x.hive_id) && x.active !== false)) {
        await db.updateDocument(DB_ID, 'hive_staff', h.$id, { active: false }).catch(() => undefined);
      }
      log?.(`HIVE staff list: ${added} added, ${changed} updated.`);
      return send({ ok: true, added, updated: changed });
    }

    const [charges, profiles, settings] = await Promise.all([
      listAll(ctx, 'staff_charges', [Query.equal('decision', ['deduct', 'part'])]),
      listAll(ctx, 'staff_profiles').catch(() => []),
      db.getDocument(DB_ID, 'settings', 'main').catch(() => ({})),
    ]);

    if (path === '/hive/deductions') {
      const since = /^\d{4}-\d{2}-\d{2}$/.test(String(body.since || '')) ? body.since : '';
      const out = deductionsFor(charges, profiles, { includeSent: body.include_sent === true, since, currency: settings.currency_code || 'GHS' });
      log?.(`HIVE read ${out.deductions.length} deduction${out.deductions.length === 1 ? '' : 's'}${out.held.length ? `, ${out.held.length} held` : ''}.`);
      return send({ ok: true, decimals: settings.currency_decimals ?? 2, ...out });
    }

    // /hive/ack
    const refs = Array.isArray(body.refs) ? body.refs.map(String).slice(0, 1000) : null;
    if (!refs) return send({ ok: false, error: 'Send { refs: ["POS-…"] }.' }, 400);
    const taken = [];
    const unknown = [];
    for (const r of refs) {
      const c = charges.find((x) => x.$id === unref(r));
      if (!c || !(takenFromPay(c) > 0)) { unknown.push(r); continue; }
      if (!c.hive_sent_at) {
        const staffId = c.hive_staff_id || profiles.find((p) => p.$id === c.person_id)?.hive_staff_id || '';
        await db.updateDocument(DB_ID, 'staff_charges', c.$id, { hive_sent_at: stamp, hive_staff_id: staffId });
      }
      taken.push(r);
    }
    log?.(`HIVE took ${taken.length} deduction${taken.length === 1 ? '' : 's'}.`);
    return send({ ok: true, taken, ...(unknown.length ? { unknown } : {}) });
  } catch (e) {
    if (!e.status) error?.(`HIVE ${path}: ${e.message}`);
    return send({ ok: false, error: e.message }, e.status || 500);
  }
}
