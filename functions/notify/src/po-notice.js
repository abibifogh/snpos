/**
 * Telling the admins when somebody makes a purchase order.
 *
 * An order is money about to be committed to a supplier on the business's
 * name, and the people who answer for that should hear about it the moment it
 * is made, not the next time they happen to open Purchase orders. Over the
 * approval limit it cannot go anywhere until one of them agrees, so the email
 * is what starts the clock; under it, it can be sent straight away, and the
 * email is how an owner knows it was.
 *
 * WHEN. Once the order is DONE — waiting for approval, or ready to send —
 * not while it is a draft. A draft is somebody still writing, and saving one
 * three times while they look things up would be three emails about an order
 * that does not exist yet. Each order is told about once, stamped
 * `admin_told_at`, so its own later updates never send again.
 *
 * WHO. The admins, from their staff profiles, leaving out whoever made it:
 * an owner who orders the beer does not need an email saying so. Where no
 * admin has an email address on file at all, the people who get the stock
 * alerts instead — an order nobody hears about is the failure that matters.
 *
 * Plain JavaScript, importing only the PO words, so a test can load it.
 */
import { quantityWords } from './po-pdf.js';

/** The statuses that mean somebody pressed Done. */
const TOLD_ABOUT = ['waiting', 'ready'];

/**
 * Whether this order should be told about now.
 *
 * Never one that came from a float in Insight: that was bought and paid for
 * before it got here, so there is nothing to agree to and no supplier to send
 * it to. Checking it is the whole of it. See insight-floats.js.
 */
export function orderToTell(doc) {
  return !!doc && TOLD_ABOUT.includes(doc.status) && !doc.admin_told_at && !doc.insight_key && doc.paid_by !== 'float';
}

const SIDE = { kitchen: 'Kitchen', bar: 'Bar', craft: 'Shop' };

/**
 * Who to email: active admins with an address, not the person who made it.
 * `fallback` is used only when no admin has an address at all.
 */
export function orderNoticeRecipients(profiles, creatorId, fallback = []) {
  const admins = (profiles || []).filter((p) => p && p.role === 'admin' && p.active !== false);
  const withEmail = admins.filter((p) => String(p.email || '').trim());
  if (withEmail.length === 0) return [...new Set(fallback.filter(Boolean))];
  const mine = (p) => creatorId && (p.$id === creatorId || p.user_id === creatorId);
  return [...new Set(withEmail.filter((p) => !mine(p)).map((p) => String(p.email).trim()))];
}

/** "PO-0004 to Accra Brewery needs your approval · GH₵7,200.00" */
export function orderNoticeSubject(doc, money) {
  const to = doc.supplier_name ? ` to ${doc.supplier_name}` : '';
  return doc.status === 'waiting'
    ? `${doc.po_no}${to} needs your approval · ${money(doc.total || 0)}`
    : `New purchase order ${doc.po_no}${to} · ${money(doc.total || 0)}`;
}

function readLines(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** The email body: what, for whom, how much, and where to deal with it. */
export function orderNoticeBody(doc, money, esc) {
  const lines = readLines(doc.lines).filter((l) => (Number(l.qty) || 0) > 0);
  const who = doc.created_by_name ? esc(doc.created_by_name) : 'Somebody';
  const side = SIDE[doc.module] ? ` for the ${SIDE[doc.module].toLowerCase()}` : '';
  const lead = doc.status === 'waiting'
    ? `${who} has made purchase order <strong>${esc(doc.po_no)}</strong>${side}. It is over the approval limit, `
      + 'so it cannot be sent to the supplier until an admin agrees to it.'
    : `${who} has made purchase order <strong>${esc(doc.po_no)}</strong>${side}. It is under the approval limit, `
      + 'so it is ready to send to the supplier now.';
  const where = doc.status === 'waiting'
    ? 'Approve or refuse it under <strong>Approvals</strong>.'
    : 'It is under <strong>Stock, Purchase orders</strong>.';

  const items = lines.map((l) => {
    const cost = Math.round((Number(l.qty) || 0) * (Number(l.unit_cost) || 0));
    return `<li><strong>${esc(l.name)}</strong> — ${esc(quantityWords(l))}${cost ? `, ${money(cost)}` : ''}</li>`;
  }).join('');

  const facts = [
    doc.supplier_name ? `To <strong>${esc(doc.supplier_name)}</strong>` : null,
    doc.expected_on ? `needed by ${esc(String(doc.expected_on).replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3/$2/$1'))}` : null,
  ].filter(Boolean).join(', ');

  return `<p style="margin:0 0 10px">${lead}</p>`
    + (facts ? `<p style="margin:0 0 10px">${facts}.</p>` : '')
    + (items ? `<ul style="margin:0 0 10px;padding-left:18px;font-size:14px;line-height:1.7">${items}</ul>` : '')
    + `<p style="margin:0 0 10px;font-weight:600">Expected total ${money(doc.total || 0)}</p>`
    + (doc.note ? `<p style="margin:0 0 10px;white-space:pre-wrap;color:#5d6b7a">${esc(doc.note)}</p>` : '')
    + `<p style="margin:0;color:#5d6b7a;font-size:14px">${where}</p>`;
}
