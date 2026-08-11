/**
 * A till receipt as a real PDF, written by hand.
 *
 * No library, deliberately. A receipt is monospaced text on a narrow roll, and
 * PDF has Courier built into every reader on earth, so there is no font to
 * embed, nothing to lay out, and no dependency to install inside a function on
 * a plan with tight limits. The whole format needed here is a few hundred
 * bytes of header and one text stream.
 *
 * The one real constraint: the built-in fonts are Latin-1. The cedi sign is
 * not in Latin-1, so money is written with the currency code (GHS 12.00)
 * rather than the symbol. Better a readable code than a black diamond where
 * the amount should be.
 */

/** Courier is 600/1000 em wide at every size, the only reason this is easy. */
const CHAR_W = 0.6;

const LATIN1_SAFE = {
  '₵': 'GHS', // cedi
  '₦': 'NGN', // naira
  '’': "'", '‘': "'", '“': '"', '”': '"',
  '–': '-', ', ': '-', '…': '...', '·': '-',
  '×': 'x', '−': '-',
};

/** Anything a built-in font cannot draw becomes something it can. */
function latin1(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    if (LATIN1_SAFE[ch] !== undefined) out += LATIN1_SAFE[ch];
    else if (ch.charCodeAt(0) <= 0xff) out += ch;
    else out += '?';
  }
  return out;
}

const esc = (s) => latin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/**
 * The page, built as a list of lines before anything is measured.
 *
 * Height comes out of the line count rather than being fixed, because a
 * receipt roll has no page two, a bill for twenty covers should be one long
 * page, not a document somebody has to scroll through.
 */
class Receipt {
  constructor({ widthPt = 226.77, margin = 12, size = 8.5 } = {}) {
    this.width = widthPt;
    this.margin = margin;
    this.size = size;
    this.lines = [];
    this.inner = widthPt - margin * 2;
    this.cols = Math.floor(this.inner / (size * CHAR_W));
  }

  /** Wrap on spaces so a long dish name does not run off the paper. */
  #wrap(text, cols) {
    const words = latin1(text).split(/\s+/).filter(Boolean);
    const out = [];
    let line = '';
    for (const w of words) {
      if (!line) line = w;
      else if ((line + ' ' + w).length <= cols) line += ' ' + w;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
    return out.length ? out : [''];
  }

  text(s, { bold = false, size = this.size, indent = 0 } = {}) {
    for (const l of this.#wrap(s, Math.floor((this.inner - indent) / (size * CHAR_W)))) {
      this.lines.push({ kind: 'left', text: l, bold, size, indent });
    }
    return this;
  }

  centre(s, { bold = false, size = this.size } = {}) {
    for (const l of this.#wrap(s, Math.floor(this.inner / (size * CHAR_W)))) {
      this.lines.push({ kind: 'centre', text: l, bold, size });
    }
    return this;
  }

  /** Label left, amount right, on one line, the shape of every receipt. */
  pair(left, right, { bold = false, size = this.size } = {}) {
    const cols = Math.floor(this.inner / (size * CHAR_W));
    const r = latin1(right);
    const l = latin1(left);
    const room = cols - r.length - 1;
    if (room < 4) {
      this.lines.push({ kind: 'left', text: l, bold, size, indent: 0 });
      this.lines.push({ kind: 'right', text: r, bold, size });
      return this;
    }
    const wrapped = this.#wrap(l, room);
    wrapped.forEach((piece, i) => {
      const isLast = i === wrapped.length - 1;
      const pad = cols - piece.length - (isLast ? r.length : 0);
      this.lines.push({
        kind: 'left',
        text: isLast ? piece + ' '.repeat(Math.max(1, pad)) + r : piece,
        bold,
        size,
        indent: 0,
      });
    });
    return this;
  }

  rule(char = '-') {
    const cols = Math.floor(this.inner / (this.size * CHAR_W));
    this.lines.push({ kind: 'left', text: char.repeat(cols), bold: false, size: this.size, indent: 0 });
    return this;
  }

  gap(n = 1) {
    for (let i = 0; i < n; i++) this.lines.push({ kind: 'gap', size: this.size });
    return this;
  }

  build() {
    const leading = (l) => l.size * 1.45;
    const height = this.margin * 2 + this.lines.reduce((h, l) => h + leading(l), 0);

    let y = height - this.margin;
    let content = '';
    let currentFont = null;
    let currentSize = null;

    for (const l of this.lines) {
      y -= leading(l);
      if (l.kind === 'gap') continue;

      const font = l.bold ? '/F2' : '/F1';
      if (font !== currentFont || l.size !== currentSize) {
        content += `BT ${font} ${l.size} Tf ET\n`;
        currentFont = font;
        currentSize = l.size;
      }

      const w = l.text.length * l.size * CHAR_W;
      let x = this.margin + (l.indent || 0);
      if (l.kind === 'centre') x = (this.width - w) / 2;
      if (l.kind === 'right') x = this.width - this.margin - w;

      content += `BT ${font} ${l.size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(l.text)}) Tj ET\n`;
    }

    return pdf(this.width, height, content);
  }
}

/** Assemble the objects, the cross-reference table and the trailer. */
function pdf(width, height, content) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width.toFixed(2)} ${height.toFixed(2)}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
  ];

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;

  return Buffer.from(out, 'latin1');
}

/**
 * The receipt itself.
 *
 * Same shape as the one the apps print, name, address, the items, the totals,
 * how it was paid, so a customer's emailed copy and a reprint from the admin
 * app are recognisably the same document.
 */
export function receiptPdf({ settings, venue, order, items, payments, methods }) {
  const money = (n) => {
    const d = settings.currency_decimals ?? 2;
    const amount = (n / 10 ** d).toFixed(d);
    return `${settings.currency_code || ''} ${amount}`.trim();
  };

  const r = new Receipt();

  r.centre(venue?.name || settings.restaurant_name, { bold: true, size: 11 });
  if (venue?.address) r.centre(venue.address, { size: 7.5 });
  if (venue?.phone) r.centre(`Phone ${venue.phone}`, { size: 7.5 });
  if (settings.email_from_address) r.centre(settings.email_from_address, { size: 7.5 });
  r.gap();
  r.centre('TAX INVOICE / RECEIPT', { size: 7.5 });
  r.rule('=');

  for (const i of items.filter((x) => x.status !== 'void')) {
    r.pair(i.name_snapshot, money(i.line_total));
    if (i.qty > 1) r.text(`  ${i.qty} @ ${money(i.unit_price)}`, { size: 7.5 });
    let addons = '';
    try {
      addons = (i.addons ? JSON.parse(i.addons) : []).map((a) => a.name).join(', ');
    } catch { addons = ''; }
    if (addons) r.text(`  ${addons}`, { size: 7.5 });
    if (i.notes) r.text(`  "${i.notes}"`, { size: 7.5 });
  }

  r.rule();
  r.pair('Sub Total', money(order.subtotal));
  if (order.discount_total) r.pair('Discount', `-${money(order.discount_total)}`);
  if (order.service_total) r.pair('Service', money(order.service_total));
  if (order.tip_total) r.pair('Tip', money(order.tip_total));
  if (!settings.tax_inclusive && order.tax_total) r.pair('Tax', money(order.tax_total));
  r.gap();
  r.pair('TOTAL', money(order.total), { bold: true, size: 11 });
  r.gap();

  for (const p of payments) {
    const name = methods.find((m) => m.$id === p.method_id)?.name || p.method_kind_snapshot || 'Payment';
    r.pair(`Tendered ${name}`, money((p.amount || 0) + (p.tip || 0)));
    if (p.change_given) r.pair('Change', money(p.change_given));
  }
  if (settings.tax_inclusive && order.tax_total) r.pair('Tax Total (incl)', money(order.tax_total));
  if (order.payment_status !== 'paid') {
    r.gap();
    r.centre('*** NOT YET PAID ***', { bold: true });
  }

  r.rule();
  r.text(new Date(order.$createdAt).toLocaleString());
  r.text(`Order No. ${order.order_no}`);
  if (order.placed_by) r.text(`Served: ${order.placed_by}`, { size: 7.5 });
  r.gap();
  r.centre('Thank you.', { size: 7.5 });

  return r.build();
}
