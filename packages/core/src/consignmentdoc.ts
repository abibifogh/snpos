import type { Settings } from './types';
import type { Consignor, ConsignmentIntake } from './consignment';
import type { Statement } from './consignment-math';
import { formatMoney } from './money';

/**
 * The two pieces of paper a consignment shop actually hands over.
 *
 * A delivery slip when work arrives, and a statement when it sells. Both are
 * built as whole documents rather than as something to print off a screen: a
 * maker keeps these, forwards them, argues from them, and a screenshot of a
 * page with a sidebar down one side is not a document anybody keeps.
 *
 * A4 rather than till-roll. These are filed, not torn off.
 */

const esc = (s: string): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const day = (iso: string) =>
  new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * The shared look.
 *
 * Set once so a slip and a statement from the same shop are recognisably the
 * same shop. Restrained on purpose: black on white, one rule under the
 * heading, generous margins. These get photographed and forwarded on a phone,
 * and anything relying on colour or on a light grey survives neither.
 */
const SHELL = `
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Helvetica Neue", Arial, sans-serif;
    font-size: 12px;
    line-height: 1.5;
    color: #111;
    background: #fff;
    -webkit-font-smoothing: antialiased;
  }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .shop { font-size: 17px; font-weight: 700; letter-spacing: 0.01em; }
  .shop .sub { font-size: 11px; font-weight: 400; color: #555; margin-top: 2px; }
  .kind { text-align: right; }
  .kind h1 { font-size: 15px; margin: 0; letter-spacing: 0.06em; text-transform: uppercase; }
  .kind .ref { font-size: 12px; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .kind .when { font-size: 11px; color: #555; }
  .rule { border-top: 2px solid #111; margin: 12px 0 18px; }

  .parties { display: flex; gap: 32px; margin-bottom: 20px; }
  .party { flex: 1; }
  .party .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #666; margin-bottom: 3px; }
  .party .who { font-weight: 650; }
  .party .line { color: #444; }

  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em;
    color: #666; padding: 0 8px 6px 0; border-bottom: 1px solid #bbb;
  }
  td { padding: 7px 8px 7px 0; border-bottom: 1px solid #eee; vertical-align: top; }
  th.num, td.num { text-align: right; padding-right: 0; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tfoot td { border-bottom: none; border-top: 2px solid #111; font-weight: 700; padding-top: 9px; }
  .sub td { border-bottom: none; padding-top: 9px; padding-bottom: 1px; }

  .note { margin-top: 18px; font-size: 11px; color: #444; }
  .sign { margin-top: 34px; display: flex; gap: 40px; }
  .sign div { flex: 1; }
  .sign .rule2 { border-top: 1px solid #111; margin-bottom: 4px; }
  .sign .cap { font-size: 10px; color: #666; }
  footer { margin-top: 26px; font-size: 10px; color: #777; text-align: center; }
`;

const header = (settings: Settings, kind: string, reference: string, when: string) => `
  <header>
    <div class="shop">
      ${esc(settings.restaurant_name || 'The shop')}
      <div class="sub">Consignment</div>
    </div>
    <div class="kind">
      <h1>${esc(kind)}</h1>
      <div class="ref">${esc(reference)}</div>
      <div class="when">${esc(when)}</div>
    </div>
  </header>
  <div class="rule"></div>`;

/**
 * What the shop keeps, said the way it was agreed.
 *
 * A flat amount printed as a percentage is a different percentage at every
 * price, which is exactly the confusion a written agreement exists to prevent.
 */
const commissionLabel = (
  c: Pick<Consignor, 'commission_bp' | 'commission_flat'>,
  settings: Settings,
): string =>
  (c.commission_flat ?? 0) > 0
    ? `${formatMoney(c.commission_flat as number, settings)} per piece`
    : `${(c.commission_bp / 100).toFixed(c.commission_bp % 100 ? 1 : 0)}%`;

/**
 * Who this is between.
 *
 * `showCommission` is off for a statement. A statement is a maker's record of
 * what they are owed, and the shop's own margin printed across the top of it
 * turns a settlement into a negotiation. It stays on the delivery slip, where
 * it belongs: a maker who signs a slip that does not mention the terms has
 * agreed to nothing.
 */
const partyBlock = (consignor: Consignor, settings: Settings, showCommission = true) => `
  <div class="parties">
    <div class="party">
      <div class="label">Consignor</div>
      <div class="who">${esc(consignor.name)}</div>
      ${consignor.phone ? `<div class="line">${esc(consignor.phone)}</div>` : ''}
      ${consignor.email ? `<div class="line">${esc(consignor.email)}</div>` : ''}
      <div class="line">Code ${esc(consignor.code)}</div>
    </div>
    <div class="party">
      <div class="label">${showCommission ? 'Received by' : 'From'}</div>
      <div class="who">${esc(settings.restaurant_name || 'The shop')}</div>
      ${showCommission ? `<div class="line">Commission ${esc(commissionLabel(consignor, settings))}</div>` : ''}
    </div>
  </div>`;

export interface SlipPiece {
  name: string;
  /** How many were handed over. Always counted as a positive. */
  qty: number;
  /** The shop's shelf price for one. */
  price: number;
  /**
   * What one earns the consignor at the agreed terms.
   *
   * Given rather than derived, because the terms can be a percentage or a flat
   * amount per piece, and only the caller holds the piece's own override.
   */
  due: number;
}

/**
 * The slip that goes back with somebody who has just dropped work off.
 *
 * It exists to settle one question later: what was handed over, on what day,
 * and what it is worth to them. So it carries the pieces, the agreed
 * commission, and a line for both signatures. The commission is on it because
 * a maker who signs a slip that does not mention it has agreed to nothing.
 *
 * The money on it is the maker's, not the shop's. A slip that priced everything
 * at the shelf price was handing somebody a document about a number they will
 * never receive, and the difference is exactly the commission they had just
 * agreed to; two figures for the same basket on the same piece of paper is how
 * an argument starts.
 *
 * Quantities are what came in. Building it off what is currently on the shelf
 * meant a reprinted slip counted down as things sold, and could print a
 * negative, which is not a thing anybody has ever handed over.
 */
export function buildDeliverySlipHtml(d: {
  intake: ConsignmentIntake;
  consignor: Consignor;
  pieces: SlipPiece[];
  settings: Settings;
}): string {
  const { intake, consignor, pieces, settings } = d;
  const money = (n: number) => formatMoney(n, settings);
  const qtyOf = (p: SlipPiece) => Math.abs(Math.round(p.qty)) || 1;

  const rows = pieces
    .map(
      (p) => `<tr>
        <td>${esc(p.name)}</td>
        <td class="num">${qtyOf(p)}</td>
        <td class="num">${esc(money(p.due))}</td>
        <td class="num">${esc(money(p.due * qtyOf(p)))}</td>
      </tr>`,
    )
    .join('');

  const total = pieces.reduce((sum, p) => sum + p.due * qtyOf(p), 0);
  const count = pieces.reduce((sum, p) => sum + qtyOf(p), 0);

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Delivery slip ${esc(intake.reference)}</title>
<style>${SHELL}</style>
</head><body>
${header(settings, 'Delivery slip', intake.reference, day(intake.received_at))}
${partyBlock(consignor, settings)}

<table>
  <thead>
    <tr><th>Piece</th><th class="num">Qty</th><th class="num">Yours, each</th><th class="num">Yours</th></tr>
  </thead>
  <tbody>${rows}</tbody>
  <tfoot>
    <tr>
      <td>${count} piece${count === 1 ? '' : 's'} received</td>
      <td class="num"></td><td class="num"></td>
      <td class="num">${esc(money(total))}</td>
    </tr>
  </tfoot>
</table>

<p class="note">
  The amounts above are yours, after the agreed commission. A full sale of this
  delivery would earn you ${esc(money(total))}.
  You are paid on what sells, not on what is received.
</p>
${intake.notes ? `<p class="note">${esc(intake.notes)}</p>` : ''}

<div class="sign">
  <div><div class="rule2"></div><div class="cap">Consignor</div></div>
  <div><div class="rule2"></div><div class="cap">For ${esc(settings.restaurant_name || 'the shop')}</div></div>
</div>

<footer>${esc(intake.reference)} · Keep this slip. Quote the reference with any question about this delivery.</footer>
</body></html>`;
}

/**
 * A consignor's statement as a document, not as a screenshot of a page.
 *
 * Four questions, in the order a maker asks them: what did I bring you, what
 * has sold, what have you paid me, and what is still sitting on your shelf.
 * The balance follows from those and is shown last.
 *
 * The shop's own margin is not on it. It used to run down the middle of the
 * page as "Sold for" and "Shop kept", which turned a settlement into a
 * negotiation every time one was handed over: the commission was agreed at
 * intake and signed for on the delivery slip, and repeating it beside every
 * line invites the conversation to be had again from scratch. What belongs on a
 * statement is what the maker is owed.
 *
 * The opening balance is on it deliberately: a statement whose figures only
 * reconcile against something else is a statement that starts an argument
 * rather than settling one.
 */
export function buildStatementHtml(d: {
  statement: Statement<Consignor>;
  settings: Settings;
  /** What is owed today, when that differs from the period's closing figure. */
  owedNow?: number;
}): string {
  const { statement: st, settings } = d;
  const money = (n: number) => formatMoney(n, settings);
  const date = (iso: string) => new Date(iso).toLocaleDateString();

  /** A section, or nothing at all when there is nothing to say. */
  const section = (title: string, head: string, body: string, foot: string) =>
    body
      ? `<h2>${esc(title)}</h2>
         <table>
           <thead><tr>${head}</tr></thead>
           <tbody>${body}</tbody>
           ${foot ? `<tfoot><tr>${foot}</tr></tfoot>` : ''}
         </table>`
      : '';

  const broughtIn = section(
    'What you brought in',
    '<th>Date</th><th>Delivery</th><th class="num">Pieces</th><th class="num">Worth to you</th>',
    st.broughtIn.lines
      .map((l) => `<tr>
        <td>${esc(date(l.at))}</td>
        <td>${esc(l.reference)}${l.note ? `<div class="sub-note">${esc(l.note)}</div>` : ''}</td>
        <td class="num">${l.pieces}</td>
        <td class="num">${l.value ? esc(money(l.value)) : ''}</td>
      </tr>`)
      .join(''),
    `<td colspan="2">${st.broughtIn.pieces} piece${st.broughtIn.pieces === 1 ? '' : 's'} received</td>
     <td class="num"></td><td class="num">${esc(money(st.broughtIn.value))}</td>`,
  );

  const sold = section(
    'What has sold',
    '<th>Date</th><th>Piece</th><th class="num">Qty</th><th class="num">Yours</th>',
    st.sold
      .map((l) => `<tr>
        <td>${esc(date(l.at))}</td>
        <td>${esc(l.description)}</td>
        <td class="num">${l.qty || ''}</td>
        <td class="num">${esc(money(l.amount))}</td>
      </tr>`)
      .join(''),
    `<td colspan="2">${st.soldCount} piece${st.soldCount === 1 ? '' : 's'} sold</td>
     <td class="num"></td><td class="num">${esc(money(st.earned))}</td>`,
  );

  const paid = section(
    'What you have been paid',
    '<th>Date</th><th>How</th><th class="num"></th><th class="num">Paid</th>',
    st.payments
      .map((l) => `<tr>
        <td>${esc(date(l.at))}</td>
        <td>${esc(l.description)}</td>
        <td class="num"></td>
        <td class="num">${esc(money(Math.abs(l.amount)))}</td>
      </tr>`)
      .join(''),
    `<td colspan="2">Paid to you in this period</td>
     <td class="num"></td><td class="num">${esc(money(st.paidOut))}</td>`,
  );

  const other = section(
    'Adjustments',
    '<th>Date</th><th>What</th><th class="num"></th><th class="num">Amount</th>',
    st.other
      .map((l) => `<tr>
        <td>${esc(date(l.at))}</td>
        <td>${esc(l.description)}</td>
        <td class="num"></td>
        <td class="num">${esc(money(l.amount))}</td>
      </tr>`)
      .join(''),
    '',
  );

  const unsold = section(
    'Still to sell',
    '<th>Piece</th><th></th><th class="num">Left</th><th class="num">Worth to you</th>',
    st.unsold.lines
      .map((l) => `<tr>
        <td>${esc(l.name)}</td>
        <td></td>
        <td class="num">${l.qty}</td>
        <td class="num">${esc(money(l.value))}</td>
      </tr>`)
      .join(''),
    `<td colspan="2">${st.unsold.pieces} piece${st.unsold.pieces === 1 ? '' : 's'} still on the shelf</td>
     <td class="num"></td><td class="num">${esc(money(st.unsold.value))}</td>`,
  );

  const period = `${date(st.from)} to ${date(st.to)}`;
  const differs =
    typeof d.owedNow === 'number' && Math.round(d.owedNow) !== Math.round(st.closingBalance);

  const nothingAtAll =
    !broughtIn && !sold && !paid && !other;

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Statement ${esc(st.consignor.code)} ${esc(period)}</title>
<style>${SHELL}
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em; margin: 22px 0 6px; }
  .sub-note { color: #666; font-size: 11px; }
  .summary { margin-top: 26px; border-top: 2px solid #111; padding-top: 10px; }
  .summary table { width: auto; min-width: 62%; margin-left: auto; }
  .summary td { border-bottom: none; padding: 3px 0 3px 18px; }
  .summary tr.total td { border-top: 1px solid #111; font-weight: 700; font-size: 13px; padding-top: 8px; }
</style>
</head><body>
${header(settings, 'Statement', st.consignor.code, period)}
${partyBlock(st.consignor, settings, false)}

${broughtIn}
${sold}
${paid}
${other}
${nothingAtAll ? '<p class="note">Nothing happened between these dates.</p>' : ''}
${unsold}

<div class="summary">
  <table>
    <tbody>
      <tr><td>Owed to you at ${esc(date(st.from))}</td><td class="num">${esc(money(st.openingBalance))}</td></tr>
      <tr><td>Earned in this period</td><td class="num">${esc(money(st.earned))}</td></tr>
      ${st.adjustments ? `<tr><td>Adjustments</td><td class="num">${esc(money(st.adjustments))}</td></tr>` : ''}
      <tr><td>Paid to you</td><td class="num">${st.paidOut ? `− ${esc(money(st.paidOut))}` : esc(money(0))}</td></tr>
      <tr class="total">
        <td>Owed to you at ${esc(date(st.to))}</td>
        <td class="num">${esc(money(st.closingBalance))}</td>
      </tr>
    </tbody>
  </table>
</div>

${differs
  ? `<p class="note"><strong>Owed right now, including anything sold since
     ${esc(date(st.to))}: ${esc(money(d.owedNow as number))}.</strong></p>`
  : ''}

<footer>
  Every line here comes from a recorded sale or payment. Ask about any of them and it can be shown to you.
</footer>
</body></html>`;
}
