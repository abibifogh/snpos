/**
 * A report as a printable document.
 *
 * Deliberately not "print the page". A dashboard is laid out for a screen, a
 * sidebar, cards three across, colours that assume a backlight, and printing
 * it produces something nobody wants to hand to an accountant. This builds a
 * separate A4 document from the same figures, so the PDF is a report rather
 * than a screenshot of one.
 *
 * The browser turns it into a PDF, which is why there is no PDF library here.
 */

export interface ReportStat {
  label: string;
  value: string;
  note?: string;
}

export interface ReportTable {
  title: string;
  headers: string[];
  rows: string[][];
  /** Columns to right-align, by index, money and counts. */
  numeric?: number[];
  /** A bar drawn behind each row, 0–1, for share-of-total tables. */
  bars?: number[];
  footnote?: string;
}

export interface ReportDoc {
  title: string;
  restaurantName: string;
  venueName?: string;
  period: string;
  generatedAt?: Date;
  generatedBy?: string;
  logoUrl?: string;
  /** The headline figures, across the top. */
  stats: ReportStat[];
  tables: ReportTable[];
  /** Printed small at the very bottom. */
  note?: string;
  /** Used for the accent rule and bar fills; the restaurant's own colour. */
  brandColor?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildReportHtml(d: ReportDoc): string {
  const brand = d.brandColor || '#0f766e';
  const when = d.generatedAt ?? new Date();

  const statCards = d.stats
    .map(
      (s) => `
      <div class="stat">
        <div class="stat-l">${esc(s.label)}</div>
        <div class="stat-v">${esc(s.value)}</div>
        ${s.note ? `<div class="stat-n">${esc(s.note)}</div>` : ''}
      </div>`,
    )
    .join('');

  const tables = d.tables
    .filter((t) => t.rows.length > 0)
    .map(
      (t) => `
      <section class="block">
        <h2>${esc(t.title)}</h2>
        <table>
          <thead><tr>${t.headers
            .map((h, i) => `<th class="${t.numeric?.includes(i) ? 'num' : ''}">${esc(h)}</th>`)
            .join('')}</tr></thead>
          <tbody>
            ${t.rows
              .map(
                (r, ri) => `<tr>${r
                  .map(
                    (c, ci) =>
                      `<td class="${t.numeric?.includes(ci) ? 'num' : ''}">${
                        ci === 0 && t.bars
                          ? `<span class="bar" style="width:${Math.round((t.bars[ri] ?? 0) * 100)}%"></span>`
                          : ''
                      }<span class="cell">${esc(c)}</span></td>`,
                  )
                  .join('')}</tr>`,
              )
              .join('')}
          </tbody>
        </table>
        ${t.footnote ? `<p class="foot">${esc(t.footnote)}</p>` : ''}
      </section>`,
    )
    .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>${esc(d.title)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #16202b; background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 11pt; line-height: 1.45; -webkit-font-smoothing: antialiased;
  }

  header { display: flex; align-items: flex-start; gap: 14px; padding-bottom: 12px; }
  header img { width: 46px; height: 46px; border-radius: 8px; object-fit: cover; }
  .who { flex: 1; }
  .rest { font-size: 15pt; font-weight: 650; letter-spacing: -0.01em; }
  .sub { color: #5d6b7a; font-size: 9.5pt; }
  .doct { text-align: right; font-size: 9.5pt; color: #5d6b7a; }
  .doct strong { display: block; font-size: 13pt; color: #16202b; font-weight: 650; }
  .rule { height: 3px; background: ${brand}; border-radius: 2px; margin-bottom: 18px; }

  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }
  .stat {
    flex: 1 1 130px; border: 1px solid #e3e7ec; border-radius: 8px;
    padding: 9px 11px; break-inside: avoid;
  }
  .stat-l { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em; color: #5d6b7a; }
  .stat-v { font-size: 16pt; font-weight: 650; letter-spacing: -0.02em; margin-top: 1px; }
  .stat-n { font-size: 8.5pt; color: #5d6b7a; }

  .block { margin-top: 20px; break-inside: avoid; }
  h2 {
    font-size: 11pt; font-weight: 650; margin: 0 0 6px;
    padding-bottom: 4px; border-bottom: 1px solid #e3e7ec;
  }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  th {
    text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.05em;
    color: #5d6b7a; font-weight: 600; padding: 5px 7px; border-bottom: 1px solid #e3e7ec;
  }
  td { padding: 5px 7px; border-bottom: 1px solid #f0f2f5; position: relative; }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .cell { position: relative; }
  /* A share-of-total bar behind the label, rather than a chart nobody can
     read in greyscale. Prints correctly because it is a solid block. */
  .bar {
    position: absolute; left: 0; top: 3px; bottom: 3px;
    background: ${brand}; opacity: 0.13; border-radius: 3px;
  }
  .foot { font-size: 8.5pt; color: #5d6b7a; margin: 5px 0 0; }

  footer {
    margin-top: 24px; padding-top: 8px; border-top: 1px solid #e3e7ec;
    font-size: 8.5pt; color: #5d6b7a; display: flex; justify-content: space-between; gap: 10px;
  }
  @media screen {
    body { max-width: 210mm; margin: 20px auto; padding: 18mm 14mm; box-shadow: 0 2px 24px rgba(16,24,40,0.15); }
  }
  @media print { .stat, .block { break-inside: avoid; } }
</style></head>
<body>
  <header>
    ${d.logoUrl ? `<img src="${esc(d.logoUrl)}" alt="">` : ''}
    <div class="who">
      <div class="rest">${esc(d.restaurantName)}</div>
      <div class="sub">${esc(d.venueName || '')}</div>
    </div>
    <div class="doct">
      <strong>${esc(d.title)}</strong>
      ${esc(d.period)}
    </div>
  </header>
  <div class="rule"></div>

  <div class="stats">${statCards}</div>
  ${tables}

  <footer>
    <span>Generated ${esc(when.toLocaleString())}${d.generatedBy ? ` · ${esc(d.generatedBy)}` : ''}</span>
    <span>${esc(d.note || '')}</span>
  </footer>
</body></html>`;
}
