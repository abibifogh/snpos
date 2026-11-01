/**
 * Orders bought out of a float held in Insight, the group hub.
 *
 * Some staff hold a cash float that Insight keeps the books of. When one of
 * them buys something for the bistro, the bar or the craft shop, Insight makes
 * the purchase order HERE, as a draft, rather than in Odoo. A manager then
 * checks it on Purchase orders, picks the stock item for any line the POS
 * could not match by name, and receives it into stock through the usual spend
 * form. The money left the float, not a drawer, a petty cash box or the bank
 * here, so that spend is marked as paid from a float: no drawer is counted
 * short for it, and the books credit 2310 Paid from floats (Insight).
 *
 * This is the POS's half, three signed paths:
 *
 *   POST /floats/po          make the draft (once per Insight key)
 *   POST /floats/po/status   where some of them have got to
 *   POST /floats/po/cancel   take one back, while it is still a draft
 *
 * SIGNED the same way as the Approvals paths (see insight-approvals.js):
 * X-Till-At and X-Till-Sig, HMAC-SHA256 with INSIGHT_SSO_SECRET over
 * "till-link", the time, the path and the body, each on its own line, within
 * five minutes.
 *
 * NOBODY BY NAME. These are Insight's own calls, not a person pressing a
 * button here, so there is no email in the body and nobody to look up. What
 * they write is put down to "insight", and the audit trail says device
 * "Insight". Who in Insight did it goes into the order's note, in words.
 *
 * NEVER CREATES a supplier or a stock item. A name that matches is used; one
 * that does not is kept on the order as written, for the manager to sort out.
 *
 * See docs/21-insight-floats.md.
 */
import { signedByHub } from './insight-approvals.js';

const PATHS = ['/floats/po', '/floats/po/status', '/floats/po/cancel'];
const MODULES = ['kitchen', 'bar', 'craft'];
/** The receipt photo, as base64. A little over 5 MB of text is a ~3.7 MB file. */
const MAX_RECEIPT_CHARS = 5 * 1024 * 1024;
/** The extensions the receipts bucket takes, by type. See BUCKETS in scripts/schema.mjs. */
const RECEIPT_TYPES = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_LINES = 60;
const VENUE = 'main';
const ACTOR = 'insight';

const fail = (message, status) => Object.assign(new Error(message), { status });
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

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

/**
 * The function's copy of saveDropping (packages/core/src/client.ts).
 *
 * Appwrite refuses a whole write for one attribute it does not know, and the
 * Insight attributes on stock_orders only exist once Provision has been run
 * since they were added. An order from a float is worth more than its
 * bookkeeping fields, so an unknown one is dropped and the write tried again,
 * and the caller is told which were dropped.
 */
export function droppingWriter(db, DB_ID) {
  return async function saveDropping(table, id, payload) {
    const body = { ...payload };
    const dropped = [];
    for (let attempt = 0; attempt < 16; attempt += 1) {
      try {
        const doc = id
          ? await db.updateDocument(DB_ID, table, id, body)
          : await db.createDocument(DB_ID, table, 'unique()', body);
        return { doc, dropped };
      } catch (e) {
        const unknown = /unknown attribute:?\s*"?([A-Za-z0-9_]+)"?/i.exec(String(e?.message ?? e));
        if (!unknown || !(unknown[1] in body)) throw e;
        dropped.push(unknown[1]);
        delete body[unknown[1]];
      }
    }
    throw new Error(`Could not save to ${table}.`);
  };
}

/* ----------------------------------------------------- matching by name */

/** Lower case, words only: "Tonic Water (330ml)" is "tonic water 330ml". */
export const normalName = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/** Words that say nothing about which item it is. */
const FILLER = new Set(['a', 'an', 'the', 'of', 'and', 'for', 'with', 'x', 'pcs', 'pc', 'per', 'each', 'pack', 'packs', 'crate', 'crates', 'box', 'boxes', 'case', 'cases', 'carton', 'cartons', 'bag', 'bags']);
const wordsOf = (s) => normalName(s).split(' ').filter((w) => w && !FILLER.has(w) && !/^\d+$/.test(w));

/**
 * The stock item a bought line is, or null when nothing is sure enough.
 *
 * Careful on purpose: the wrong Soda booked into stock is a shortage on one
 * shelf and a surplus on another, found weeks later at a count, while a line
 * left unmatched only asks a manager to pick it. So:
 *
 *   1. the same name, ignoring case and punctuation;
 *   2. every word of an item's name in the line ("Tonic water" in "Tonic
 *      water 330ml, crate of 24"), the item with the most words winning, and
 *      a tie is no answer;
 *   3. otherwise most words shared both ways (at least two, and three in four
 *      of the longer name's), again with a tie no answer.
 */
export function matchItem(name, items) {
  const want = normalName(name);
  if (!want) return null;
  const live = items.filter((i) => i && i.active !== false && normalName(i.name));
  const exact = live.filter((i) => normalName(i.name) === want);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const lineWords = new Set(wordsOf(name));
  if (lineWords.size === 0) return null;
  const best = (scored) => {
    if (scored.length === 0) return null;
    scored.sort((a, b) => b.score - a.score);
    return scored.length > 1 && scored[0].score === scored[1].score ? null : scored[0].item;
  };

  const inside = live.flatMap((i) => {
    const w = wordsOf(i.name);
    return w.length > 0 && w.join(' ').length >= 4 && w.every((x) => lineWords.has(x)) ? [{ item: i, score: w.length }] : [];
  });
  if (inside.length) return best(inside);

  const close = live.flatMap((i) => {
    const w = new Set(wordsOf(i.name));
    const shared = [...w].filter((x) => lineWords.has(x)).length;
    const longer = Math.max(w.size, lineWords.size);
    return shared >= 2 && shared / longer >= 0.75 ? [{ item: i, score: shared / longer }] : [];
  });
  return best(close);
}

const hasPack = (i) => Number.isFinite(i?.pack_size) && i.pack_size > 1;
/** The same plural as purchase-orders.ts, so the lines read alike. */
const plural = (w) => {
  const s = (w || '').trim() || 'unit';
  return /s$|kg$|ml$|cl$|g$|l$/i.test(s) ? s : `${s}s`;
};

/**
 * The order's lines, in the shape PoLine has (packages/core/src/purchase-orders.ts).
 *
 * How many and what was paid are the receipt's; the price of one is what was
 * paid over how many. A line matched to an item is bought in its pack where it
 * has one, as a delivery usually is; the manager can change that. One not
 * matched carries no item, and the name as it was read.
 */
export function orderLines(body, items) {
  const given = Array.isArray(body.lines) ? body.lines : [];
  const raw = given.length
    ? given
    : [{ name: body.description || 'Bought from a float', qty: 1, amount: body.total }];
  return raw.slice(0, MAX_LINES).map((l) => {
    const name = clip(l?.name, 160) || 'An item';
    const q = Number(l?.qty);
    const qty = Number.isFinite(q) && q > 0 ? Math.round(q * 1000) / 1000 : 1;
    const amount = Math.max(0, Math.round(Number(l?.amount) || 0));
    const unitCost = Math.round(amount / qty);
    const item = matchItem(name, items);
    if (!item) {
      return { ingredient_id: '', name, unit: '', buy_key: 'unit', buy_label: '', per: 1, qty, unit_cost: unitCost, received_qty: 0, bought_as: name };
    }
    const pack = hasPack(item);
    return {
      ingredient_id: item.$id,
      name: item.name,
      unit: item.unit || '',
      buy_key: pack ? 'pack' : 'unit',
      buy_label: pack ? plural(item.pack_name || 'pack') : plural(item.unit),
      per: pack ? item.pack_size : 1,
      qty,
      unit_cost: unitCost,
      received_qty: 0,
      bought_as: name,
    };
  });
}

/** The highest PO number so far, plus one. The same rule as nextPoNo in purchase-orders.ts. */
export function nextPoNo(used) {
  const top = used.reduce((m, n) => {
    const d = Number(/(\d+)$/.exec(n ?? '')?.[1] ?? 0);
    return Number.isFinite(d) && d > m ? d : m;
  }, 0);
  return `PO-${String(top + 1).padStart(4, '0')}`;
}

const money = (minor, symbol) => `${symbol}${(Number(minor || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const whose = (holder) => (holder ? `${holder}'s float` : 'A float');

/** The shape Insight is answered with, for one order. */
const answer = (o, appUrl) => ({
  id: o.$id,
  poNo: o.po_no,
  status: o.status,
  total: Number(o.total) || 0,
  module: o.module || 'kitchen',
  receivedAt: o.received_at || null,
  url: appUrl ? `${appUrl.replace(/\/+$/, '')}/#/purchase-orders?show=${o.$id}` : null,
});

/**
 * The receipt, put in the bucket the till's spend receipts go to, readable by
 * managers and admins only. Null when there is none, it is too big, or it
 * could not be stored: a missing photo must never cost the order.
 */
async function storeReceipt({ storage, makeFile, settings, receipt, key, log }) {
  if (!storage || !receipt || typeof receipt.data !== 'string' || !receipt.data) return null;
  const ext = RECEIPT_TYPES[String(receipt.mime || '').toLowerCase()];
  if (!ext) { log?.(`Float order ${key}: receipt type ${receipt.mime} is not one the bucket takes.`); return null; }
  if (receipt.data.length > MAX_RECEIPT_CHARS) { log?.(`Float order ${key}: receipt too big to keep.`); return null; }
  try {
    const bucket = settings?.storage_mode === 'single' && settings.shared_bucket_id ? settings.shared_bucket_id : 'receipts';
    const name = `${normalName(key).replace(/ /g, '-') || 'float'}.${ext}`;
    const file = await makeFile(Buffer.from(receipt.data, 'base64'), name);
    const made = await storage.createFile(bucket, 'unique()', file, ['read("team:managers")', 'read("team:admins")']);
    return made?.$id || null;
  } catch (e) {
    log?.(`Float order ${key}: the receipt could not be stored (${e.message}).`);
    return null;
  }
}

/** The order with this Insight key that still counts, if there is one. */
async function existingFor({ db, DB_ID, Query }, key) {
  let rows;
  try {
    rows = await listAll(db, DB_ID, Query, 'stock_orders', [Query.equal('insight_key', key)]);
  } catch {
    // Not provisioned for it yet: look the slow way.
    rows = await listAll(db, DB_ID, Query, 'stock_orders', [Query.equal('venue_id', VENUE)]).catch(() => []);
  }
  return rows.find((o) => o.insight_key === key && o.status !== 'cancelled') ?? null;
}

/** Make the draft order, or hand back the one already made for this key. */
export async function makeFloatOrder({ db, DB_ID, Query, storage, makeFile, body, appUrl = '', log }) {
  const key = clip(body?.key, 64);
  if (!key) throw fail('Which purchase is it? The key is missing.', 400);
  const module = String(body?.module || '');
  if (!MODULES.includes(module)) throw fail('The module must be kitchen, bar or craft.', 400);
  const total = Number(body?.total);
  if (!Number.isInteger(total) || total < 0) throw fail('The total must be a whole number of minor units.', 400);
  if (body.lines !== undefined && !Array.isArray(body.lines)) throw fail('The lines must be a list.', 400);

  const already = await existingFor({ db, DB_ID, Query }, key);
  if (already) return { order: already, again: true, dropped: [] };

  const [items, suppliers, settings, used] = await Promise.all([
    listAll(db, DB_ID, Query, 'ingredients', [Query.equal('venue_id', VENUE)]).catch(() => []),
    listAll(db, DB_ID, Query, 'suppliers').catch(() => []),
    db.getDocument(DB_ID, 'settings', 'main').catch(() => ({})),
    listAll(db, DB_ID, Query, 'stock_orders', [Query.equal('venue_id', VENUE)]).then((r) => r.map((o) => o.po_no)).catch(() => []),
  ]);
  // This side's own items, as the order form offers them. No side was the kitchen's.
  const mine = items.filter((i) => (i.module ?? 'kitchen') === module);
  const lines = orderLines(body, mine);
  const linesJson = JSON.stringify(lines);
  if (linesJson.length > 20000) throw fail('Too many lines for one order.', 400);

  const typed = clip(body.supplier, 160);
  const found = typed
    ? (suppliers.filter((s) => s.active !== false).find((s) => normalName(s.name) === normalName(typed))
      ?? suppliers.find((s) => normalName(s.name) === normalName(typed)))
    : null;

  const holder = clip(body.holder, 100);
  const ref = clip(body.ref, 40);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.day || '')) ? body.day : '';
  const sum = lines.reduce((n, l) => n + Math.round(l.qty * l.unit_cost), 0);
  const symbol = settings?.currency_symbol || 'GH₵';
  const note = [
    [`From Insight: ${whose(holder)}`, ref, day ? `bought ${day}` : '', body.by ? `sent by ${clip(body.by, 80)}` : ''].filter(Boolean).join(' · '),
    clip(body.description, 200) ? `For: ${clip(body.description, 200)}` : '',
    clip(body.hint, 300) ? `They said: “${clip(body.hint, 300)}”` : '',
    sum !== total ? `The receipt says ${money(total, symbol)}; the lines come to ${money(sum, symbol)}.` : '',
  ].filter(Boolean).join('\n').slice(0, 1000);

  const fileId = await storeReceipt({ storage, makeFile, settings, receipt: body.receipt, key, log });
  const saveDropping = droppingWriter(db, DB_ID);
  const order = {
    venue_id: VENUE,
    po_no: nextPoNo(used),
    module,
    supplier_id: found?.$id ?? '',
    supplier_name: found?.name ?? (typed || 'Supplier to confirm'),
    supplier_email: found?.email ?? '',
    supplier_phone: found?.phone ?? '',
    status: 'draft',
    lines: linesJson,
    total,
    note,
    expected_on: '',
    created_by: ACTOR,
    created_by_name: `Insight (${whose(holder)})`.slice(0, 120),
    insight_key: key,
    insight_ref: ref,
    insight_from: whose(holder).slice(0, 160),
    receipt_file_id: fileId ?? '',
    paid_by: 'float',
  };
  const { doc, dropped } = await saveDropping('stock_orders', null, order);
  await db.createDocument(DB_ID, 'audit_log', 'unique()', {
    venue_id: VENUE, actor_id: ACTOR, actor_role: 'system', action: 'po_from_float', entity_type: 'purchase_orders',
    entity_id: doc.$id, reason: [whose(holder), ref].filter(Boolean).join(' · ').slice(0, 500), device: 'Insight', shift_id: '',
  }).catch(() => undefined);
  return { order: { ...order, ...doc }, again: false, dropped };
}

/** Where each of these orders has got to. Ids not found are left out. */
export async function floatOrderStatus({ db, DB_ID, Query, body }) {
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map((x) => String(x || '')).filter(Boolean))] : null;
  if (!ids) throw fail('Which orders? Send ids as a list.', 400);
  if (ids.length > 100) throw fail('At most 100 at a time.', 400);
  if (ids.length === 0) return [];
  const rows = await listAll(db, DB_ID, Query, 'stock_orders', [Query.equal('$id', ids)]);
  return ids.map((id) => rows.find((o) => o.$id === id)).filter(Boolean);
}

/**
 * Take an order back, from Insight. Only while it is still a draft that came
 * from there: once a manager has checked it, it is the POS's to cancel.
 */
export async function cancelFloatOrder({ db, DB_ID, body }) {
  const id = clip(body?.id, 64);
  if (!id) throw fail('Which order?', 400);
  const note = clip(body?.note, 500);
  const by = clip(body?.by, 80);
  const row = await db.getDocument(DB_ID, 'stock_orders', id).catch(() => null);
  if (!row) throw fail('The POS has no such order.', 404);
  const name = row.po_no || 'That order';
  if (!row.insight_key) throw fail(`${name} was not made by Insight, so it is cancelled in the POS.`, 409);
  if (row.status === 'cancelled') return row;
  if (row.status !== 'draft') {
    const why = ['received', 'part'].includes(row.status)
      ? `${name} has already been received in the POS: it cannot be cancelled from Insight.`
      : `${name} is already being received in the POS: cancel it there first.`;
    throw fail(why, 409);
  }
  await droppingWriter(db, DB_ID)('stock_orders', id, { status: 'cancelled', decided_note: note });
  await db.createDocument(DB_ID, 'audit_log', 'unique()', {
    venue_id: row.venue_id || VENUE, actor_id: ACTOR, actor_role: 'system', action: 'po_cancelled', entity_type: 'purchase_orders',
    entity_id: id, reason: [by ? `By ${by} in Insight` : 'From Insight', note].filter(Boolean).join(': ').slice(0, 500), device: 'Insight', shift_id: '',
  }).catch(() => undefined);
  return { ...row, status: 'cancelled' };
}

/** The receipt as a file Appwrite will take, from node-appwrite. Loaded only when there is one. */
const defaultMakeFile = async (buffer, name) => {
  const { InputFile } = await import('node-appwrite/file');
  return InputFile.fromBuffer(buffer, name);
};

/**
 * The three paths, for main.js. Returns null when the request is not for
 * them, and has already answered when it is.
 */
export async function handleInsightFloats({ req, res, db, DB_ID, Query, storage, makeFile = defaultMakeFile, log, error, env = process.env }) {
  const path = String(req.path || '/').replace(/\/+$/, '') || '/';
  if (!PATHS.includes(path)) return null;
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
  if (!body || typeof body !== 'object' || Array.isArray(body)) return send({ ok: false, error: 'That was not a JSON object.' }, 400);
  const appUrl = env.APP_URL || '';
  try {
    if (path === '/floats/po') {
      const { order, again, dropped } = await makeFloatOrder({ db, DB_ID, Query, storage, makeFile, body, appUrl, log });
      const a = answer(order, appUrl);
      if (!again) log?.(`Float order ${a.poNo} made from Insight (${body.key}).`);
      return send({
        ok: true, id: a.id, poNo: a.poNo, status: a.status, total: a.total, module: a.module, url: a.url,
        ...(again ? { already: true } : {}),
        ...(dropped.length ? { warning: `This POS has not been provisioned for orders from Insight yet (${dropped.join(', ')} not kept). Run Provision.` } : {}),
      });
    }
    if (path === '/floats/po/status') {
      const rows = await floatOrderStatus({ db, DB_ID, Query, body });
      return send({
        ok: true,
        orders: rows.map((o) => {
          const a = answer(o, appUrl);
          return { id: a.id, poNo: a.poNo, status: a.status, total: a.total, receivedAt: a.receivedAt, module: a.module };
        }),
      });
    }
    const row = await cancelFloatOrder({ db, DB_ID, body });
    log?.(`Float order ${row.po_no} cancelled from Insight.`);
    return send({ ok: true, status: 'cancelled' });
  } catch (e) {
    if (!e.status) error?.(`Floats from Insight: ${e.message}`);
    return send({ ok: false, error: e.message }, e.status || 500);
  }
}
