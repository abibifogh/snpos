/**
 * What waits here for an admin, for the group hub's Approvals page, and the
 * decision made from there.
 *
 * Insight (the hub) lists everything waiting for its admins in every system
 * in one place, and a decision pressed there is made in the system it came
 * from, as the person who pressed it. This is the POS's half: two signed
 * paths, `/approvals/list` and `/approvals/decide`.
 *
 * WHO. Insight names the person by email. They must be a user here with an
 * active staff profile: an admin decides everything below; a manager the
 * spends, purchase orders and group bookings, as the Waiting page and the
 * default page access already let them. Nobody is created and nobody is
 * widened, the same rules as the sign-in hand-off in sso.js.
 *
 * WHAT. Each decision is the same write the admin app makes (see the
 * functions named beside each one in packages/core), so everything this
 * function already does on those writes still happens: a refused spend is
 * reversed in the books, a decided group booking emails the guest. Every
 * decision also leaves an audit_log row with device "Insight", so the trail
 * says where it was pressed.
 *
 * NOT HERE. Counts (bar, kitchen, store-room and shop) and shelf changes move
 * stock through rules that live in the app, so they are listed with a link to
 * Approvals rather than decided from outside. So is refusing a group
 * booking whose meal times are already on the kitchen's list, which in the app
 * also cancels them and gives money back.
 *
 * SIGNED. The request carries X-Till-At and X-Till-Sig: HMAC-SHA256 with the
 * hub's shared secret (INSIGHT_SSO_SECRET, the one the hand-off uses) over
 * "till-link", the time, the path and the body, each on its own line, within
 * five minutes. The same signature Insight and HIVE use with each other.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const LABEL = 'till-link';
const WINDOW_MS = 5 * 60 * 1000;

/** Whether a request was signed by the hub, recently, for this path and body. */
export function signedByHub(secret, { at, sig, path, bodyText, now = Date.now() }) {
  if (!secret || !at || !sig) return false;
  const stamp = Number(at);
  if (!Number.isFinite(stamp) || Math.abs(now - stamp) > WINDOW_MS) return false;
  const want = createHmac('sha256', secret).update(`${LABEL}\n${at}\n${path}\n${bodyText}`).digest('hex');
  const a = Buffer.from(want);
  const b = Buffer.from(String(sig));
  return a.length === b.length && timingSafeEqual(a, b);
}

const MANAGERS_TOO = new Set(['spend', 'order', 'group_booking', 'booking_change']);
/** Whether this role may decide this kind here. */
export const mayDecide = (role, kind) => role === 'admin' || (role === 'manager' && MANAGERS_TOO.has(kind));

const money = (minor, symbol) => `${symbol}${(Number(minor || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Accra' });
};
const LIVE_SITTING = (s) => !['CANCELLED', 'REJECTED', 'CLOSED', 'SERVED'].includes(String(s.status || ''));
const parseLines = (text) => { try { const l = JSON.parse(text || '[]'); return Array.isArray(l) ? l : []; } catch { return []; } };

/** Every document matching, a page at a time. */
async function listAll(db, DB_ID, Query, table, queries = []) {
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

/** The person Insight named: their user here, and their staff profile. */
async function personFor({ users, db, DB_ID, Query }, email) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) throw Object.assign(new Error('Whose approvals?'), { status: 400 });
  const found = await users.list([Query.equal('email', address)]);
  const user = (found.users || []).find((u) => String(u.email || '').toLowerCase() === address && u.status !== false);
  if (!user) throw Object.assign(new Error(`No POS login has the email ${address}.`), { status: 403 });
  const profiles = await listAll(db, DB_ID, Query, 'staff_profiles', [Query.equal('user_id', user.$id)]).catch(() => []);
  const byEmail = profiles.length ? [] : await listAll(db, DB_ID, Query, 'staff_profiles', [Query.equal('email', address)]).catch(() => []);
  const profile = [...profiles, ...byEmail].find((p) => p.active !== false);
  if (!profile || !['admin', 'manager'].includes(profile.role)) {
    throw Object.assign(new Error(`${user.name || address} is not an admin or a manager in the POS.`), { status: 403 });
  }
  return { user, profile, name: profile.display_name || user.name || address };
}

/** Everything waiting that this person may decide, in the hub's shape. */
export async function listWaiting({ db, DB_ID, Query, person, settings = {}, appUrl = '' }) {
  const symbol = settings.currency_symbol || 'GH₵';
  const role = person.profile.role;
  const staff = await listAll(db, DB_ID, Query, 'staff_profiles').catch(() => []);
  const nameOf = (id) => {
    const p = staff.find((s) => s.user_id === id || s.$id === id);
    return p?.display_name || null;
  };
  const open = (show) => (appUrl ? `${appUrl.replace(/\/+$/, '')}/#/waiting${show ? `?show=${show}` : ''}` : null);
  const items = [];
  const failed = [];
  const gather = async (kind, label, work) => {
    if (!mayDecide(role, kind) && kind !== 'count') return;
    try { items.push(...await work()); } catch (e) { failed.push({ kind, label, error: e.message }); }
  };

  await gather('spend', 'Spend', async () => (await listAll(db, DB_ID, Query, 'shift_expenses', [Query.equal('approval_status', 'pending')])).map((x) => ({
    kind: 'spend', kindLabel: 'Spend at the till', id: x.$id,
    title: `Spend · ${x.payee || x.category || 'from the drawer'}`,
    sub: [x.category, x.module, nameOf(x.created_by) ? `by ${nameOf(x.created_by)}` : null].filter(Boolean).join(' · '),
    who: nameOf(x.created_by), askedAt: x.$createdAt, amount: Number(x.amount) || 0,
    details: [['Paid to', x.payee], ['For', x.category], ['Note', x.note], ['From', x.from_takings ? 'the takings' : x.module], ['Recorded by', nameOf(x.created_by)]],
    decisions: [
      { key: 'approve', label: 'Approve', primary: true, note: 'none' },
      { key: 'refuse', label: 'Refuse', note: 'none', hint: 'It is reversed in the books; the shift still counts it, because the money did leave the drawer.' },
    ],
    open: open('spend'),
  })));

  await gather('order', 'Purchase order', async () => (await listAll(db, DB_ID, Query, 'stock_orders', [Query.equal('status', 'waiting')])).map((o) => {
    const lines = parseLines(o.lines);
    return {
      kind: 'order', kindLabel: 'Purchase order over the limit', id: o.$id,
      title: `${o.po_no || 'Purchase order'} · ${o.supplier_name || 'a supplier'}`,
      sub: `${lines.length} line${lines.length === 1 ? '' : 's'}${o.created_by_name ? ` · by ${o.created_by_name}` : ''}`,
      who: o.created_by_name || nameOf(o.created_by), askedAt: o.$createdAt, amount: Number(o.total) || 0,
      details: [
        ...lines.slice(0, 12).map((l) => [l.name, `${l.qty} ${l.buy_label || ''} × ${money(l.unit_cost, symbol)}`.replace(/\s+/g, ' ')]),
        lines.length > 12 ? ['And', `${lines.length - 12} more lines`] : null,
        ['Note', o.note], ['Expected', o.expected_on],
      ].filter(Boolean),
      decisions: [
        { key: 'approve', label: 'Approve', primary: true, note: 'optional', hint: 'Approved, it is ready to send to the supplier.' },
        { key: 'refuse', label: 'Refuse', note: 'optional' },
      ],
      open: open('order'),
    };
  }));

  await gather('group_booking', 'Group booking', async () => {
    const rows = await listAll(db, DB_ID, Query, 'group_bookings', [Query.equal('status', 'pending')]);
    return Promise.all(rows.map(async (b) => {
      const sittings = await listAll(db, DB_ID, Query, 'orders', [Query.equal('group_booking_id', b.$id)]).catch(() => []);
      const live = sittings.filter(LIVE_SITTING).length;
      return {
        kind: 'group_booking', kindLabel: 'Group booking', id: b.$id,
        title: `Group booking · ${b.contact_name || 'a party'}`,
        sub: [b.size ? `${b.size} people` : null, b.first_at ? day(b.first_at) : null, b.reference].filter(Boolean).join(' · '),
        who: b.contact_name, askedAt: b.$createdAt, amount: Number(b.total) || 0,
        details: [['Reference', b.reference], ['Party', b.size ? `${b.size} people, ${b.sittings || 1} sitting${(b.sittings || 1) === 1 ? '' : 's'}` : null],
          ['First meal', b.first_at ? day(b.first_at) : null], ['Contact', [b.contact_name, b.email].filter(Boolean).join(', ')], ['They said', b.note]],
        warnings: live ? [`${live} meal time${live === 1 ? ' is' : 's are'} already on the kitchen's list. To refuse it, use the POS, which cancels ${live === 1 ? 'it' : 'them'} and gives money back.`] : [],
        decisions: [
          { key: 'approve', label: 'Approve', primary: true, note: 'optional', hint: 'The guest is emailed, with the booking sheet and your note.' },
          ...(live ? [] : [{ key: 'refuse', label: 'Refuse', note: 'optional', hint: 'The guest is emailed, with your note.' }]),
        ],
        open: appUrl ? `${appUrl.replace(/\/+$/, '')}/#/group-bookings` : null,
      };
    }));
  });

  await gather('booking_change', 'Booking change', async () => (await listAll(db, DB_ID, Query, 'booking_changes', [Query.equal('status', 'open')])).map((c) => ({
    kind: 'booking_change', kindLabel: 'Change to a booking', id: c.$id,
    title: `Booking change · ${c.contact_name || c.reference || 'a party'}`,
    sub: [c.kind, c.reference, c.first_at ? day(c.first_at) : null].filter(Boolean).join(' · '),
    who: c.contact_name, askedAt: c.$createdAt, amount: null,
    details: [['Asked', c.note], ['Booking', c.reference], ['Contact', [c.contact_name, c.email].filter(Boolean).join(', ')]],
    decisions: [
      { key: 'approve', label: 'Done', primary: true, note: 'optional' },
      { key: 'refuse', label: 'Refuse', note: 'optional' },
    ],
    open: appUrl ? `${appUrl.replace(/\/+$/, '')}/#/group-bookings` : null,
  })));

  // Counts: listed, decided in the POS.
  await gather('count', 'Count', async () => {
    if (role !== 'admin') return [];
    const checks = await listAll(db, DB_ID, Query, 'shift_stock_checks', [Query.equal('applied', false)]);
    const held = checks.filter((c) => !c.rejected_at);
    const byCount = new Map();
    for (const c of held) {
      const key = `${c.shift_id}|${c.phase || ''}`;
      if (!byCount.has(key)) byCount.set(key, []);
      byCount.get(key).push(c);
    }
    const shop = await listAll(db, DB_ID, Query, 'stock_counts', [Query.equal('status', 'pending')]).catch(() => []);
    const ids = [...new Set(held.map((c) => c.ingredient_id).filter(Boolean))].slice(0, 100);
    const names = new Map((ids.length ? await listAll(db, DB_ID, Query, 'ingredients', [Query.equal('$id', ids)]).catch(() => []) : []).map((i) => [i.$id, i.name]));
    const place = (side) => (side === 'kitchen' ? 'Kitchen' : side === 'craft' ? 'Shop' : 'Bar');
    return [
      ...[...byCount.entries()].map(([key, lines]) => ({
        kind: 'count', kindLabel: 'Count held', id: key,
        title: `${place(lines[0].module)} count · ${lines.length} line${lines.length === 1 ? '' : 's'} held`,
        sub: `${String(lines[0].shift_id).startsWith('store:') ? 'Store room' : 'Shift'} count${nameOf(lines[0].checked_by) ? ` by ${nameOf(lines[0].checked_by)}` : ''}`,
        who: nameOf(lines[0].checked_by), askedAt: lines.map((l) => l.$createdAt).sort()[0], amount: null,
        details: lines.slice(0, 12).map((l) => [names.get(l.ingredient_id) || 'An item', `expected ${l.theoretical_qty ?? '?'}, counted ${l.counted_qty ?? '?'}`]),
        warnings: ['Counts move stock, so they are decided in the POS: Approvals.'],
        decisions: [], open: open('count'),
      })),
      ...shop.map((s) => ({
        kind: 'count', kindLabel: 'Shop count', id: `shop:${s.$id}`,
        title: `Shop count · ${s.note === 'Changed on the products page.' ? 'shelf change' : 'stocktake'}`,
        sub: [s.line_count ? `${s.line_count} line${s.line_count === 1 ? '' : 's'}` : null, nameOf(s.counted_by) ? `by ${nameOf(s.counted_by)}` : null].filter(Boolean).join(' · ') || 'waiting',
        who: nameOf(s.counted_by), askedAt: s.counted_at || s.$createdAt, amount: null,
        details: [['Note', s.note], ['Missing', s.missing_pieces ? `${s.missing_pieces} pieces` : null], ['Over', s.surplus_pieces ? `${s.surplus_pieces} pieces` : null]],
        warnings: ['Counts move stock, so they are decided in the POS: Approvals.'],
        decisions: [], open: open('count'),
      })),
    ];
  });

  return { items, failed };
}

/** One decision, written as the admin app writes it, with an audit row saying it came from Insight. */
export async function decide({ db, DB_ID, Query, person, body }) {
  const kind = String(body?.kind || '');
  const id = String(body?.id || '');
  const decision = String(body?.decision || '');
  const note = String(body?.note || '').slice(0, 500);
  if (!['approve', 'refuse'].includes(decision)) throw Object.assign(new Error('The POS does not know that decision.'), { status: 400 });
  if (!id) throw Object.assign(new Error('Which one?'), { status: 400 });
  if (kind === 'count') throw Object.assign(new Error('Counts are decided in the POS: Approvals.'), { status: 400 });
  if (!mayDecide(person.profile.role, kind)) throw Object.assign(new Error(`Your POS login may not decide that.`), { status: 403 });
  const by = person.user.$id;
  const now = new Date().toISOString();
  const yes = decision === 'approve';
  const gone = (what) => Object.assign(new Error(`That ${what} has already been decided.`), { status: 409 });
  const audit = (entity, action, shiftId = '', venue = 'main') => db.createDocument(DB_ID, 'audit_log', 'unique()', {
    venue_id: venue, actor_id: by, actor_role: person.profile.role, action, entity_type: entity, entity_id: id,
    reason: note, device: 'Insight', shift_id: shiftId || '',
  }).catch(() => undefined);

  if (kind === 'spend') {
    // decideSpend, packages/core/src/spend-decide.ts
    const row = await db.getDocument(DB_ID, 'shift_expenses', id);
    if (row.approval_status !== 'pending') throw gone('spend');
    await db.updateDocument(DB_ID, 'shift_expenses', id, { approval_status: yes ? 'approved' : 'rejected', approved_by: by });
    await audit('shift_expenses', yes ? 'spend_approved' : 'spend_refused', row.shift_id, row.venue_id || 'main');
    return { said: yes ? 'Approved' : 'Refused' };
  }
  if (kind === 'order') {
    // decidePurchaseOrder, packages/core/src/purchase-orders-store.ts
    const row = await db.getDocument(DB_ID, 'stock_orders', id);
    if (row.status !== 'waiting') throw gone('purchase order');
    await db.updateDocument(DB_ID, 'stock_orders', id, { status: yes ? 'ready' : 'refused', approved_by: by, approved_at: now, decided_note: note });
    await audit('purchase_orders', yes ? 'po_approved' : 'po_refused', '', row.venue_id || 'main');
    return { said: yes ? 'Approved' : 'Refused' };
  }
  if (kind === 'group_booking') {
    // decideGroupBooking, packages/core/src/group-bookings.ts. Writing it is what emails the guest.
    const row = await db.getDocument(DB_ID, 'group_bookings', id);
    if (row.status !== 'pending') throw gone('booking');
    if (!yes) {
      const sittings = await listAll(db, DB_ID, Query, 'orders', [Query.equal('group_booking_id', id)]).catch(() => []);
      if (sittings.some(LIVE_SITTING)) throw Object.assign(new Error('Its meal times are on the kitchen\'s list: refuse it in the POS, which cancels them and gives money back.'), { status: 409 });
    }
    await db.updateDocument(DB_ID, 'group_bookings', id, { status: yes ? 'approved' : 'refused', decided_by: by, decided_at: now, decided_note: note });
    await audit('group_bookings', yes ? 'group_booking_approved' : 'group_booking_refused', '', row.venue_id || 'main');
    return { said: yes ? 'Approved' : 'Refused' };
  }
  if (kind === 'booking_change') {
    // decideBookingChange, packages/core/src/group-bookings.ts
    const row = await db.getDocument(DB_ID, 'booking_changes', id);
    if (row.status !== 'open') throw gone('change');
    await db.updateDocument(DB_ID, 'booking_changes', id, { status: yes ? 'done' : 'refused', decided_by: by, decided_at: now, reply: note });
    await audit('booking_changes', yes ? 'booking_change_done' : 'booking_change_refused', '', row.venue_id || 'main');
    return { said: yes ? 'Done' : 'Refused' };
  }
  throw Object.assign(new Error('The POS does not know that kind of approval.'), { status: 400 });
}

/**
 * The two paths, for main.js. Returns null when the request is not for them,
 * and has already answered when it is.
 */
export async function handleInsightApprovals({ req, res, db, DB_ID, users, Query, log, error, env = process.env }) {
  const path = String(req.path || '/').replace(/\/+$/, '') || '/';
  if (path !== '/approvals/list' && path !== '/approvals/decide') return null;
  const send = (body, status = 200) => res.json(body, status);
  if (String(req.method || '').toUpperCase() !== 'POST') return send({ ok: false, error: 'POST only.' }, 405);
  const secret = env.INSIGHT_SSO_SECRET || '';
  if (!secret) return send({ ok: false, error: 'This POS is not connected to the group hub: INSIGHT_SSO_SECRET is not set.' }, 503);
  const bodyText = typeof req.bodyText === 'string' ? req.bodyText : typeof req.body === 'string' ? req.body : JSON.stringify(req.bodyJson ?? {});
  const header = (name) => req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  if (!signedByHub(secret, { at: header('x-till-at'), sig: header('x-till-sig'), path, bodyText })) {
    return send({ ok: false, error: 'That request did not come from the group hub.' }, 401);
  }
  let body;
  try { body = JSON.parse(bodyText || '{}'); } catch { return send({ ok: false, error: 'That was not JSON.' }, 400); }
  try {
    const person = await personFor({ users, db, DB_ID, Query }, body.email);
    if (path === '/approvals/list') {
      const settings = await db.getDocument(DB_ID, 'settings', 'main').catch(() => ({}));
      const out = await listWaiting({ db, DB_ID, Query, person, settings, appUrl: env.APP_URL || '' });
      return send({ ok: true, as: person.name, ...out });
    }
    const out = await decide({ db, DB_ID, Query, person, body });
    log?.(`Approvals: ${body.kind} ${body.id} ${body.decision} by ${person.name}, from Insight`);
    return send({ ok: true, as: `${person.name} via Insight`, ...out });
  } catch (e) {
    if (!e.status) error?.(`Approvals from Insight: ${e.message}`);
    return send({ ok: false, error: e.message }, e.status || 500);
  }
}
