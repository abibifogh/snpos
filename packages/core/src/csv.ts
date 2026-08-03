/**
 * CSV, for the spreadsheet somebody is going to open it in.
 *
 * Excel is the target, and Excel has opinions. Two of them matter enough to
 * work around here, because getting either wrong turns a clean export into an
 * afternoon of retyping.
 */

/**
 * Quote a value so a spreadsheet reads it back as what it is.
 *
 * The leading-quote trick guards against CSV injection: a cell beginning with
 * =, +, - or @ is treated as a formula by Excel and Sheets, so an order note
 * reading "=cmd|..." becomes something the spreadsheet tries to run. Prefixing
 * a tab keeps the text visible and stops it being parsed.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `\t${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))];
  // A BOM, so Excel opens it as UTF-8 rather than mangling ₵ and every accent.
  return `﻿${lines.join('\r\n')}`;
}

/** Hand the browser a file to save. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
