/**
 * A4 documents, written by hand.
 *
 * The same reasoning as receipt-pdf.js, one size up. A receipt is monospaced
 * text on a roll and needs nothing but Courier; a kitchen sheet for a party of
 * forty is a laid-out page — headings, rules, a filled band per sitting, an
 * amount column that lines up — and it has to break across pages without a
 * dish being cut in half.
 *
 * Still no library. The three built-in Helvetica faces are in every reader on
 * earth, so there is nothing to embed and nothing to install inside a function
 * on a plan with tight limits. What proportional type costs is the width
 * table below: Courier is one width and needs no arithmetic, Helvetica is 95
 * numbers. They are the published metrics, and an error in one would show as
 * a line wrapping a word early, not as a broken file.
 *
 * The one real constraint is inherited: the built-in fonts are Latin-1, so the
 * cedi sign is written as its currency code. Better a readable GHS than a
 * black diamond where the amount should be.
 */

/*
  The built-in fonts are set in WinAnsi, which is Latin-1 plus a handful of
  typographic characters in the 0x80 row. A bullet is one of them, so it is
  written as its WinAnsi byte and comes out as a bullet rather than as the
  question mark everything unmappable becomes. The middle dot and the
  multiplication sign are plain Latin-1 and need no help at all.
*/
const LATIN1_SAFE = {
  '₵': 'GHS', // cedi
  '₦': 'NGN', // naira
  '’': "'", '‘': "'", '“': '"', '”': '"',
  '–': '-', '—': '-', '…': '...',
  '−': '-', '€': 'EUR',
  '•': '\x95', // WinAnsi bullet
};

/** Anything a built-in font cannot draw becomes something it can. */
export function latin1(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    if (LATIN1_SAFE[ch] !== undefined) out += LATIN1_SAFE[ch];
    else if (ch.charCodeAt(0) <= 0xff) out += ch;
    else out += '?';
  }
  return out;
}

export const esc = (s) =>
  latin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/* ------------------------------------------------------------ how wide is it */

// Published Helvetica metrics, per 1000 em, for codes 32 to 126.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * An accented letter is as wide as the letter under it.
 *
 * Near enough, and only near enough is needed: this decides where a line
 * wraps, not what is drawn. A name with an é in it must not wrap a word early
 * and must never fall off the page, and folding gets both right.
 */
const FOLD = {
  À: 'A', Á: 'A', Â: 'A', Ã: 'A', Ä: 'A', Å: 'A', Æ: 'A', Ç: 'C',
  È: 'E', É: 'E', Ê: 'E', Ë: 'E', Ì: 'I', Í: 'I', Î: 'I', Ï: 'I',
  Ñ: 'N', Ò: 'O', Ó: 'O', Ô: 'O', Õ: 'O', Ö: 'O', Ø: 'O',
  Ù: 'U', Ú: 'U', Û: 'U', Ü: 'U', Ý: 'Y',
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', æ: 'a', ç: 'c',
  è: 'e', é: 'e', ê: 'e', ë: 'e', ì: 'i', í: 'i', î: 'i', ï: 'i',
  ñ: 'n', ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o', ø: 'o',
  ù: 'u', ú: 'u', û: 'u', ü: 'u', ý: 'y', ÿ: 'y', ß: 'B',
  // The punctuation that survives as itself, measured as its nearest ASCII.
  '·': '.', '×': 'x', '\x95': 'o', '£': 'L', '°': 'o',
};

/** How wide a string is, in points, set in this face at this size. */
export function widthOf(text, size, bold = false) {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let units = 0;
  for (const raw of latin1(text)) {
    const ch = FOLD[raw] ?? raw;
    const code = ch.charCodeAt(0);
    units += code >= 32 && code <= 126 ? table[code - 32] : 556;
  }
  return (units / 1000) * size;
}

/* ------------------------------------------------------------------- colour */

/** '#0f766e' as the three numbers a content stream wants. */
export function rgb(hex) {
  const clean = String(hex || '').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [0, 0, 0];
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
}

const paint = (hex) => rgb(hex).map((n) => n.toFixed(3)).join(' ');

/* --------------------------------------------------------------- the page */

const FONTS = { regular: '/F1', bold: '/F2', italic: '/F3' };

/**
 * A page you write down, that starts a new one when it runs out.
 *
 * Everything is measured on the way in rather than laid out afterwards,
 * because the only question this document ever asks is "does the next block
 * fit below the last one", and a block that does not fit starts page two.
 */
export class Doc {
  constructor({ width = 595.28, height = 841.89, margin = 42 } = {}) {
    this.width = width;
    this.height = height;
    this.margin = margin;
    this.pages = [];
    this.body = '';
    this.y = height - margin;
  }

  get left() { return this.margin; }

  get right() { return this.width - this.margin; }

  get inner() { return this.width - this.margin * 2; }

  newPage() {
    this.pages.push(this.body);
    this.body = '';
    this.y = this.height - this.margin;
    return this;
  }

  /** Start a new page unless this much room is left above the footer. */
  need(h) {
    if (this.y - h < this.margin + 26) this.newPage();
    return this;
  }

  gap(h = 8) {
    this.y -= h;
    return this;
  }

  /** Break a string into lines that fit a width, on spaces where it can. */
  wrap(text, size, bold, width) {
    const words = latin1(text).split(/\s+/).filter(Boolean);
    const out = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (widthOf(next, size, bold) <= width || !line) {
        // A single word wider than the column still goes on its own line
        // rather than disappearing; a dish name is worth an overhang.
        line = next;
      } else {
        out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
    return out.length ? out : [''];
  }

  fill(x, y, w, h, colour) {
    this.body += `${paint(colour)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`;
    return this;
  }

  /** One line of text at an exact spot. Nothing moves. */
  put(text, x, y, { size = 10, font = 'regular', colour = '#1a2230' } = {}) {
    const face = FONTS[font] ?? FONTS.regular;
    this.body += `${paint(colour)} rg BT ${face} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(text)}) Tj ET\n`;
    return this;
  }

  /**
   * A block of text down the page, wrapped, moving the cursor past it.
   *
   * `align` is 'left' or 'right'; right is for money, which is the only thing
   * on this page that has to line up with the thing above it.
   */
  text(s, {
    size = 10, font = 'regular', colour = '#1a2230', x = null, width = null,
    align = 'left', leading = null, after = 0,
  } = {}) {
    const bold = font === 'bold';
    const startX = x ?? this.left;
    const room = width ?? this.right - startX;
    const step = leading ?? size * 1.32;
    for (const line of this.wrap(s, size, bold, room)) {
      this.need(step);
      this.y -= step;
      const at = align === 'right' ? startX + room - widthOf(line, size, bold) : startX;
      this.put(line, at, this.y, { size, font, colour });
    }
    if (after) this.gap(after);
    return this;
  }

  /**
   * Label on the left, value hard against the right.
   *
   * The label wraps if it has to and the value stays on the first line, which
   * is the shape of every price list ever printed.
   */
  pair(left, right, {
    size = 10, font = 'regular', colour = '#1a2230', valueFont = null,
    valueColour = null, x = null, width = null, after = 0,
  } = {}) {
    const startX = x ?? this.left;
    const room = width ?? this.right - startX;
    const vFont = valueFont ?? font;
    const vWidth = widthOf(right, size, vFont === 'bold');
    const step = size * 1.32;
    const lines = this.wrap(left, size, font === 'bold', Math.max(40, room - vWidth - 12));
    lines.forEach((line, i) => {
      this.need(step);
      this.y -= step;
      this.put(line, startX, this.y, { size, font, colour });
      if (i === 0 && right) {
        this.put(right, startX + room - vWidth, this.y, {
          size, font: vFont, colour: valueColour ?? colour,
        });
      }
    });
    if (after) this.gap(after);
    return this;
  }

  rule({ colour = '#dde3ea', thickness = 0.7, above = 4, below = 6, x = null, width = null } = {}) {
    const startX = x ?? this.left;
    const room = width ?? this.right - startX;
    this.need(above + below + thickness);
    this.y -= above;
    this.fill(startX, this.y, room, thickness, colour);
    this.y -= below;
    return this;
  }

  /** A filled band with text in it. The thing that separates one sitting from the next. */
  band(text, {
    colour = '#0f766e', ink = '#ffffff', size = 11, font = 'bold', padding = 7, right = '',
  } = {}) {
    const h = size * 1.3 + padding * 2;
    this.need(h + 6);
    this.y -= h;
    this.fill(this.left, this.y, this.inner, h, colour);
    const baseline = this.y + padding + size * 0.24;
    this.put(text, this.left + 10, baseline, { size, font, colour: ink });
    if (right) {
      this.put(right, this.right - 10 - widthOf(right, size, font === 'bold'), baseline, {
        size, font, colour: ink,
      });
    }
    this.gap(6);
    return this;
  }

  /**
   * The bytes.
   *
   * `foot` is given the page number and the count, so a sheet that runs to
   * three pages says so on all three — a kitchen sheet with a page missing
   * and no way to tell is how a table gets forgotten.
   *
   * @param {object} [options]
   * @param {((page: number, total: number) => string) | null} [options.foot]
   */
  build({ foot = null } = {}) {
    const pages = [...this.pages, this.body];
    if (foot) {
      pages.forEach((_, i) => {
        const words = foot(i + 1, pages.length);
        if (!words) return;
        const size = 8;
        const x = (this.width - widthOf(words, size, false)) / 2;
        pages[i] += `${paint('#8a97a6')} rg BT /F1 ${size} Tf ${x.toFixed(2)} `
          + `${(this.margin - 14).toFixed(2)} Td (${esc(words)}) Tj ET\n`;
      });
    }
    return assemble(pages, this.width, this.height);
  }
}

/* ------------------------------------------- objects, xref table and trailer */

function assemble(pages, width, height) {
  const objects = [];
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  // 2 is the page tree, filled in below once the kids are known.
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>';

  const kids = [];
  pages.forEach((content, i) => {
    const pageNo = 6 + i * 2;
    const streamNo = pageNo + 1;
    kids.push(`${pageNo} 0 R`);
    objects[pageNo - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width.toFixed(2)} ${height.toFixed(2)}] `
      + '/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> '
      + `/Contents ${streamNo} 0 R >>`;
    objects[streamNo - 1] =
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`;
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((bodyText, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${bodyText}\nendobj\n`;
  });

  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;

  return Buffer.from(out, 'latin1');
}
