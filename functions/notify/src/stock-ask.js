/**
 * Telling whoever orders stock that the kitchen or the bar has asked for some.
 *
 * Approvals shows the request the moment it is sent, with a number on its
 * icon, but nobody sits watching Approvals. One email per request, to the
 * people who may make orders: admins always, then whoever the Purchase orders
 * page lets order by their role, and anyone set to "always" on Staff, less
 * anyone set to "never". Stamped `told_at`, so it is never sent twice.
 *
 * The same rule as canOrderStock in packages/core/src/access.ts, written out
 * again here because the function cannot import TypeScript. A test holds the
 * two together.
 *
 * Plain JavaScript, importing nothing, so a test can load it.
 */

const ORDER_ROLES = ['manager', 'cashier', 'waiter', 'cook'];

/** The roles the Purchase orders page lets order. Nothing stored: managers. */
export function orderRoles(settings) {
  const raw = settings && settings.po_order_roles;
  if (raw === undefined || raw === null || raw === '') return ['manager'];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? ORDER_ROLES.filter((r) => v.includes(r)) : ['manager'];
  } catch {
    return ['manager'];
  }
}

/** One person's own answer, read the way orderChoice in access.ts reads it. */
function choice(p) {
  if (p.order_stock === 'yes' || p.order_stock === 'no' || p.order_stock === 'group') return p.order_stock;
  if (p.role !== 'manager' && p.can_order_stock === true) return 'yes';
  if (p.role === 'manager' && p.can_order_stock === false) return 'no';
  return 'group';
}

/** May this person make orders. Mirrors canOrderStock. */
export function mayOrder(p, settings) {
  if (!p) return false;
  if (p.role === 'admin') return true;
  const own = choice(p);
  if (own !== 'group') return own === 'yes';
  return orderRoles(settings).includes(p.role);
}

/** Who to email: active people who may order, with an address, not whoever asked. */
export function askRecipients(profiles, settings, askerId) {
  const mine = (p) => askerId && (p.$id === askerId || p.user_id === askerId);
  return [...new Set((profiles || [])
    .filter((p) => p && p.active !== false && mayOrder(p, settings) && !mine(p))
    .map((p) => String(p.email || '').trim())
    .filter(Boolean))];
}

function readLines(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((l) => l && l.name && Number(l.qty) > 0) : [];
  } catch {
    return [];
  }
}

const one = (label, qty) => {
  const w = String(label || 'units');
  if (qty !== 1) return w;
  if (/(sh|ch|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (/^(kg|g|l|ml|cl|each)$/i.test(w)) return w;
  return w.endsWith('s') ? w.slice(0, -1) : w;
};

/** Worth telling about now: still asked, and never told. */
export const askToTell = (doc) => !!doc && doc.status === 'asked' && !doc.told_at;

/** "The kitchen needs 5 items · Kofi" */
export function askSubject(doc) {
  const n = readLines(doc.lines).length;
  const what = n > 0 ? `needs ${n} ${n === 1 ? 'item' : 'items'}` : 'sent a note about stock';
  return `The ${doc.side === 'bar' ? 'bar' : 'kitchen'} ${what}${doc.by_name ? ` · ${doc.by_name}` : ''}`;
}

/** The email body: what was asked for, the note, and where to decide it. */
export function askBody(doc, esc) {
  const lines = readLines(doc.lines);
  const who = doc.by_name ? esc(doc.by_name) : 'Somebody';
  const side = doc.side === 'bar' ? 'bar' : 'kitchen';
  const items = lines.map((l) => {
    const qty = Number(l.qty);
    const left = Number(l.left) > 0 ? `${Math.round(Number(l.left) * 100) / 100} ${esc(l.unit || '')} left` : 'run out';
    return `<li><strong>${esc(l.name)}</strong>: ${qty} ${esc(one(l.buy_label, qty))} <span style="color:#5d6b7a">(${left})</span></li>`;
  }).join('');
  return `<p style="margin:0 0 10px">${who} on the ${side} has asked for stock.</p>`
    + (items ? `<ul style="margin:0 0 10px;padding-left:18px;font-size:14px;line-height:1.7">${items}</ul>` : '')
    + (String(doc.note || '').trim() ? `<p style="margin:0 0 10px;white-space:pre-wrap;color:#5d6b7a">“${esc(doc.note)}”</p>` : '')
    + '<p style="margin:0;color:#5d6b7a;font-size:14px">Make the orders, change the amounts first, or send it back with a '
    + 'reason, under <strong>Approvals</strong>. Nothing has been ordered yet.</p>';
}
