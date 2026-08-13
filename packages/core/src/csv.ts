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

/**
 * Read a CSV back, the way a spreadsheet actually writes one.
 *
 * Hand-rolled rather than split(',') because every real file breaks that on
 * its first row: a product called "Basket, large" is one cell, not two, and a
 * maker's note with a line break in it is one cell spanning two lines. A
 * bulk upload that silently mangles those is worse than one that refuses the
 * file, because nobody checks two hundred rows by eye.
 *
 * Handles quoted fields, doubled quotes inside them, commas and newlines
 * inside quotes, CRLF and LF, and the byte order mark Excel puts at the front
 * of anything it saves as UTF-8. Blank lines are dropped: a trailing newline
 * is not a row of empty products.
 *
 * Pure. Returns rows of raw strings and makes no decision about what they
 * mean; that is stock-import.ts.
 */
export function parseCsv(text: string): string[][] {
  // Excel's byte order mark would otherwise become part of the first heading,
  // so "name" arrives as "\ufeffname" and matches nothing.
  const input = text.replace(/^\ufeff/, '');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];

    if (quoted) {
      if (c !== '"') { field += c; continue; }
      // A doubled quote inside a quoted field is one literal quote.
      if (input[i + 1] === '"') { field += '"'; i += 1; continue; }
      quoted = false;
      continue;
    }

    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }

  // Whatever was still being read when the file ended is a real cell.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // A cell written by this file's own `cell()` may carry a leading tab, added
  // to stop a spreadsheet treating it as a formula. Taking it off again here
  // means a file exported and re-imported comes back as what it was.
  return rows
    .map((r) => r.map((v) => v.replace(/^\t/, '').trim()))
    .filter((r) => r.some((v) => v !== ''));
}
