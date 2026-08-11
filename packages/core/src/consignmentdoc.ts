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

const partyBlock = (consignor: Consignor, settings: Settings) => `
  <div class="parties">
    <div class="party">
      <div class="label">Consignor</div>
      <div class="who">${esc(consignor.name)}</div>
      ${consignor.phone ? `<div class="line">${esc(consignor.phone)}</div>` : ''}
      ${consignor.email ? `<div class="line">${esc(consignor.email)}</div>` : ''}
      <div class="line">Code ${esc(consignor.code)}</div>
    </div>
    <div class="party">
      <div class="label">Received by</div>
      <div class="who">${esc(settings.restaurant_name || 'The shop')}</div>
      <div class="line">Commission ${(consignor.commission_bp / 100).toFixed(consignor.commission_bp % 100 ? 1 : 0)}%</div>
    </div>
  </div>`;

export interface SlipPiece {
  name: string;
  qty: number;
  price: number;
}

/**
 * The slip that goes back with somebody who has just dropped work off.
 *
 * It exists to settle one question later: what was handed over, on what day,
 * at what price. So it carries the pieces, the agreed commission, and a line
 * for both signatures. The commission is on it because a maker who signs a
 * slip that does not mention it has agreed to nothing.
 */
export function buildDeliverySlipHtml(d: {
  intake: ConsignmentIntake;
  consignor: Consignor;
  pieces: SlipPiece[];
  settings: Settings;
}): string {
  const { intake, consignor, pieces, settings } = d;
  const money = (n: number) => formatMoney(n, settings);

  const rows = pieces
    .map(
      (p) => `<tr>
        <td>${esc(p.name)}</td>
        <td class="num">${p.qty}</td>
        <td class="num">${esc(money(p.price))}</td>
        <td class="num">${esc(money(p.price * p.qty))}</td>
      </tr>`,
    )
    .join('');

  const total = pieces.reduce((sum, p) => sum + p.price * p.qty, 0);
  const count = pieces.reduce((sum, p) => sum + p.qty, 0);
  const theirs = total - Math.round((total * consignor.commission_bp) / 10000);

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Delivery slip ${esc(intake.reference)}</title>
<style>${SHELL}</style>
</head><body>
${header(settings, 'Delivery slip', intake.reference, day(intake.received_at))}
${partyBlock(consignor, settings)}

<table>
  <thead>
    <tr><th>Piece</th><th class="num">Qty</th><th class="num">Price each</th><th class="num">Value</th></tr>
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
  Prices shown are what the shop will sell at. At the agreed commission,
  a full sale of this delivery would earn you ${esc(money(theirs))}.
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

  const rows = st.lines
    .map(
      (l) => `<tr>
        <td>${esc(new Date(l.at).toLocaleDateString())}</td>
        <td>${esc(l.description)}</td>
        <td class="num">${l.qty || ''}</td>
        <td class="num">${l.gross ? esc(money(l.gross)) : ''}</td>
        <td class="num">${l.commission ? esc(money(l.commission)) : ''}</td>
        <td class="num">${esc(money(l.amount))}</td>
      </tr>`,
    )
    .join('');

  const period = `${new Date(st.from).toLocaleDateString()} to ${new Date(st.to).toLocaleDateString()}`;
  const differs =
    typeof d.owedNow === 'number' && Math.round(d.owedNow) !== Math.round(st.closingBalance);

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Statement ${esc(st.consignor.code)} ${esc(period)}</title>
<style>${SHELL}</style>
</head><body>
${header(settings, 'Statement', st.consignor.code, period)}
${partyBlock(st.consignor, settings)}

<table>
  <thead>
    <tr>
      <th>Date</th><th>What</th>
      <th class="num">Qty</th><th class="num">Sold for</th>
      <th class="num">Shop kept</th><th class="num">Yours</th>
    </tr>
  </thead>
  <tbody>
    <tr class="sub">
      <td colspan="5">Owed to you at ${esc(new Date(st.from).toLocaleDateString())}</td>
      <td class="num">${esc(money(st.openingBalance))}</td>
    </tr>
    ${rows || '<tr><td colspan="6">Nothing between these dates.</td></tr>'}
  </tbody>
  <tfoot>
    <tr>
      <td colspan="5">Owed to you at ${esc(new Date(st.to).toLocaleDateString())}</td>
      <td class="num">${esc(money(st.closingBalance))}</td>
    </tr>
  </tfoot>
</table>

<p class="note">
  ${st.soldCount} piece${st.soldCount === 1 ? '' : 's'} sold for ${esc(money(st.grossSales))}.
  The shop kept ${esc(money(st.commissionKept))}; you earned ${esc(money(st.earned))}.
  ${st.paidOut ? `Paid to you in this period: ${esc(money(st.paidOut))}.` : ''}
</p>
${differs
  ? `<p class="note"><strong>Owed right now, including anything sold since
     ${esc(new Date(st.to).toLocaleDateString())}: ${esc(money(d.owedNow as number))}.</strong></p>`
  : ''}

<footer>
  Every line here comes from a recorded sale or payment. Ask about any of them and it can be shown to you.
</footer>
</body></html>`;
}
