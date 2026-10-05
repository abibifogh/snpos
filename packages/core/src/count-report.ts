/**
 * Count differences waiting for approval, as a document.
 *
 * For the owner to read away from the screen, take into a conversation with
 * the bar, or keep: every count still waiting, who counted it and when, and
 * each line that differed — what the shelf said, what was found, the
 * difference, and what that is worth at the price it sells for.
 *
 * Pure. Imports nothing at runtime. Printed through the browser, which saves
 * it as a PDF; see openPrintable.
 */

export interface ReportLine {
  name: string;
  note?: string;
  expected?: number;
  counted?: number;
  delta?: number;
  unitPrice?: number;
  worth: number;
  valuedAt?: 'selling' | 'cost';
}

export interface ReportCount {
  title: string;
  /** Who counted it, by name. */
  countedBy: string;
  /** When it was filed. */
  at: string;
  lines: ReportLine[];
}

const esc = (s: string): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** What a set of lines comes to: short, over, and the two together. */
export function differenceTotals(lines: Pick<ReportLine, 'worth'>[]): { short: number; over: number; net: number } {
  const short = lines.filter((l) => l.worth < 0).reduce((a, l) => a - l.worth, 0);
  const over = lines.filter((l) => l.worth > 0).reduce((a, l) => a + l.worth, 0);
  return { short, over, net: over - short };
}

export function countDifferencesHtml(d: {
  business: string;
  counts: ReportCount[];
  money: (n: number) => string;
  /** When the document was made, and by whom, for the footer. */
  madeAt: string;
  madeBy?: string;
  when: (iso: string) => string;
}): string {
  const all = d.counts.flatMap((c) => c.lines);
  const total = differenceTotals(all);
  const anyAtCost = all.some((l) => l.valuedAt === 'cost');

  const sections = d.counts.map((c) => {
    const t = differenceTotals(c.lines);
    const rows = c.lines.map((l) => `<tr>
        <td>${esc(l.name)}${l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}</td>
        <td class="num">${l.expected ?? ''}</td>
        <td class="num">${l.counted ?? ''}</td>
        <td class="num ${(l.delta ?? 0) < 0 ? 'short' : ''}">${signed(l.delta ?? 0)}</td>
        <td class="num">${l.unitPrice !== undefined ? esc(d.money(l.unitPrice)) : ''}${l.valuedAt === 'cost' ? ' *' : ''}</td>
        <td class="num ${l.worth < 0 ? 'short' : ''}">${l.worth < 0 ? '−' : l.worth > 0 ? '+' : ''}${esc(d.money(Math.abs(l.worth)))}</td>
      </tr>`).join('');
    return `<section>
      <h2>${esc(c.title)}</h2>
      <div class="meta">Counted by <strong>${esc(c.countedBy || 'not recorded')}</strong> · ${esc(d.when(c.at))}</div>
      <table>
        <thead><tr><th>What</th><th class="num">Shelf said</th><th class="num">Found</th><th class="num">Difference</th><th class="num">Each</th><th class="num">Worth</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="4">Short ${esc(d.money(t.short))} · Over ${esc(d.money(t.over))}</td>
          <td class="num"></td>
          <td class="num">${t.net < 0 ? '−' : t.net > 0 ? '+' : ''}${esc(d.money(Math.abs(t.net)))}</td>
        </tr></tfoot>
      </table>
    </section>`;
  }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Count differences waiting for approval</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Helvetica Neue", Arial, sans-serif; font-size: 12px; line-height: 1.45; color: #111; background: #fff; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .shop { font-size: 17px; font-weight: 700; }
  .kind { text-align: right; }
  .kind h1 { font-size: 15px; margin: 0; letter-spacing: 0.06em; text-transform: uppercase; }
  .kind .when { font-size: 11px; color: #555; }
  .rule { border-top: 2px solid #111; margin: 12px 0 14px; }
  .summary { display: flex; gap: 28px; margin-bottom: 18px; }
  .summary div { font-size: 11px; color: #555; }
  .summary strong { display: block; font-size: 15px; color: #111; }
  section { margin-bottom: 22px; page-break-inside: avoid; }
  h2 { font-size: 13px; margin: 0 0 2px; }
  .meta { font-size: 11px; color: #444; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: #666; padding: 0 8px 6px 0; border-bottom: 1px solid #bbb; }
  td { padding: 6px 8px 6px 0; border-bottom: 1px solid #eee; vertical-align: top; }
  th.num, td.num { text-align: right; padding-right: 0; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.short { font-weight: 700; }
  .sub { font-size: 10px; color: #666; }
  tfoot td { border-bottom: none; border-top: 2px solid #111; font-weight: 700; padding-top: 7px; }
  .note { margin-top: 10px; font-size: 10px; color: #555; }
  footer { margin-top: 22px; font-size: 10px; color: #777; text-align: center; }
</style>
</head><body>
<header>
  <div class="shop">${esc(d.business || 'The business')}</div>
  <div class="kind"><h1>Count differences</h1><div class="when">Waiting for approval · ${esc(d.when(d.madeAt))}</div></div>
</header>
<div class="rule"></div>
<div class="summary">
  <div>Counts<strong>${d.counts.length}</strong></div>
  <div>Lines that differ<strong>${all.length}</strong></div>
  <div>Short<strong>${esc(d.money(total.short))}</strong></div>
  <div>Over<strong>${esc(d.money(total.over))}</strong></div>
  <div>Net<strong>${total.net < 0 ? '−' : total.net > 0 ? '+' : ''}${esc(d.money(Math.abs(total.net)))}</strong></div>
</div>
${sections || '<p>Nothing is waiting for approval.</p>'}
<p class="note">Differences are valued at what one sells for.${anyAtCost ? ' * Nothing on the menu sells this, so it is valued at what one cost.' : ''}</p>
<footer>Made ${esc(d.when(d.madeAt))}${d.madeBy ? ` by ${esc(d.madeBy)}` : ''}. Nothing on this page has been approved or refused.</footer>
</body></html>`;
}
