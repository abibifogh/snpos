import { inflateSync } from 'node:zlib';

/**
 * Text and provenance out of a PDF, without a PDF library.
 *
 * PDF is a page-description format, not a document format: there are no
 * paragraphs in it, only instructions to put glyphs at coordinates. So this is
 * a reconstruction, not a read, and it is honest about that. When the glyph
 * codes do not map back to readable characters (subset fonts with custom
 * encodings, or a scan with no text layer at all) the extractor says so rather
 * than handing the analysers mojibake and letting them draw conclusions.
 *
 * What a PDF does carry, and Word does not, is the tool that produced it.
 * That is often the most informative line in the whole report.
 */

/** WinAnsi's private stretch, where the typographic characters we care about live. */
const WIN_ANSI_HIGH = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…',
  0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š',
  0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’',
  0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ',
  0x9e: 'ž', 0x9f: 'Ÿ',
};

export function extractPdf(buf) {
  const raw = buf.toString('latin1');
  if (!raw.startsWith('%PDF-')) throw new Error('Not a PDF (missing %PDF header)');

  const encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(raw);
  const streams = collectStreams(buf, raw);
  const meta = readMetadata(raw, streams);

  // Each content stream is normally one page, so text is assembled page by
  // page and the offset each one starts at is recorded. That is what lets a
  // finding say "page 3" later. Whitespace is normalised per page, before any
  // offset is taken, because normalising the joined string afterwards would
  // shift every offset already handed out.
  const pageBreaks = [];
  let text = '';
  for (const s of streams) {
    if (!looksLikeContentStream(s)) continue;
    const page = textFromContentStream(s).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!page) continue;
    if (text) text += '\n\n';
    pageBreaks.push(text.length);
    text += page;
  }

  const legibility = legibleRatio(text);
  const pages = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length || meta.pageCount || null;

  return {
    kind: 'pdf',
    text: legibility >= 0.7 ? text : '',
    pageBreaks,
    meta: {
      ...meta,
      pages,
      encrypted,
      // These two drive the "can this even be assessed" note in the report.
      textLayer: text.length === 0 ? 'none' : legibility >= 0.7 ? 'extracted' : 'unreadable',
      legibility: Number(legibility.toFixed(2)),
    },
    parts: [],
  };
}

/** Every stream in the file, inflated where it is deflate-compressed. */
function collectStreams(buf, raw) {
  const out = [];
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    re.lastIndex = end;

    const slice = buf.subarray(start, end);
    try {
      out.push(inflateSync(slice).toString('latin1'));
    } catch {
      // Not deflate, or damaged. If it is plain text it is still usable; if it
      // is an image or an unsupported filter, the content-stream check drops it.
      out.push(slice.toString('latin1'));
    }
  }
  return out;
}

function looksLikeContentStream(s) {
  return /\bBT\b/.test(s) && /\b(Tj|TJ)\b/.test(s);
}

/**
 * Reconstruct reading order from drawing operators.
 *
 * Only the text-showing and text-positioning operators matter. Everything
 * else, graphics state, paths, colour, is skipped by the tokeniser.
 */
function textFromContentStream(s) {
  let out = '';
  let operands = [];
  let i = 0;

  while (i < s.length) {
    const c = s[i];

    if (c === '(') {
      const [str, next] = readLiteralString(s, i);
      operands.push({ str });
      i = next;
      continue;
    }
    if (c === '<' && s[i + 1] !== '<') {
      const end = s.indexOf('>', i);
      if (end < 0) break;
      operands.push({ str: fromHex(s.slice(i + 1, end)) });
      i = end + 1;
      continue;
    }
    if (c === '<' || c === '[' || c === ']' || c === '>') { i += c === '<' || c === '>' ? 2 : 1; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '%') { const nl = s.indexOf('\n', i); i = nl < 0 ? s.length : nl; continue; }

    // A bare token: a number, a name, or an operator.
    let j = i;
    while (j < s.length && !/[\s()<>[\]{}/%]/.test(s[j])) j++;
    if (j === i) { i++; continue; }
    const token = s.slice(i, j);
    i = j;

    if (/^[-+]?[\d.]+$/.test(token)) { operands.push({ num: Number(token) }); continue; }

    switch (token) {
      case 'Tj':
      case "'":
      case '"':
        if (token !== 'Tj') out += '\n';
        out += lastString(operands);
        break;
      case 'TJ':
        for (const op of operands) {
          if (op.str != null) out += op.str;
          // Large negative kerning is how PDF writers space words apart. The
          // threshold is empirical: below it, the gap is inter-word rather
          // than the sub-glyph tightening that normal kerning applies.
          else if (op.num != null && op.num < -120) out += ' ';
        }
        break;
      case 'Td':
      case 'TD': {
        const ty = operands.length >= 2 ? operands[operands.length - 1].num : 0;
        out += ty && Math.abs(ty) > 0.01 ? '\n' : ' ';
        break;
      }
      case 'T*':
      case 'ET':
        out += '\n';
        break;
      default:
        break;
    }
    if (/^[A-Za-z'"*]+$/.test(token)) operands = [];
  }
  return out;
}

function lastString(operands) {
  for (let k = operands.length - 1; k >= 0; k--) if (operands[k].str != null) return operands[k].str;
  return '';
}

function readLiteralString(s, start) {
  let depth = 0;
  let i = start;
  let bytes = [];
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      const octal = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4));
      if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length; continue; }
      const esc = { n: 10, r: 13, t: 9, b: 8, f: 12 }[n];
      bytes.push(esc ?? n.charCodeAt(0));
      i++;
      continue;
    }
    if (c === '(') { depth++; if (depth === 1) continue; }
    if (c === ')') { depth--; if (depth === 0) return [decodeBytes(bytes), i + 1]; }
    if (depth >= 1) bytes.push(c.charCodeAt(0) & 0xff);
  }
  return [decodeBytes(bytes), i];
}

function fromHex(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2).padEnd(2, '0'), 16));
  return decodeBytes(bytes);
}

function decodeBytes(bytes) {
  // A byte-order mark means the string is UTF-16BE, which is how non-Latin
  // text and anything with unusual characters is normally written.
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  return bytes.map((b) => WIN_ANSI_HIGH[b] ?? String.fromCharCode(b)).join('');
}

/** Share of characters that could plausibly be prose. Catches subset-font garbage. */
function legibleRatio(text) {
  if (!text.length) return 0;
  const good = (text.match(/[A-Za-z0-9\s.,;:!?'"()\-‐-’“-”À-ɏ]/g) || []).length;
  return good / text.length;
}

/**
 * The Info dictionary and any XMP packet.
 *
 * Producer and Creator identify the software that wrote the file. "Skia/PDF"
 * is Chrome's print-to-PDF, which means a web page was printed rather than a
 * document exported, and that is worth knowing about a submitted essay.
 */
function readMetadata(raw, streams) {
  const meta = {};
  const fields = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'];
  for (const f of fields) {
    const m = new RegExp(`/${f}\\s*(\\(((?:\\\\.|[^\\\\()])*)\\)|<([0-9A-Fa-f\\s]+)>)`).exec(raw);
    if (!m) continue;
    const value = m[2] != null ? readLiteralString(`(${m[2]})`, 0)[0] : fromHex(m[3] || '');
    if (value.trim()) meta[f.charAt(0).toLowerCase() + f.slice(1)] = pdfDate(value.trim());
  }

  const xmpSource = [raw, ...streams].find((s) => s.includes('<x:xmpmeta'));
  if (xmpSource) {
    const xmp = xmpSource.slice(xmpSource.indexOf('<x:xmpmeta'), xmpSource.indexOf('</x:xmpmeta>') + 12);
    meta.xmpTools = [...new Set([
      ...[...xmp.matchAll(/<xmp:CreatorTool>([^<]*)</g)].map((m) => m[1]),
      ...[...xmp.matchAll(/<pdf:Producer>([^<]*)</g)].map((m) => m[1]),
      ...[...xmp.matchAll(/stEvt:softwareAgent="([^"]*)"/g)].map((m) => m[1]),
    ])].filter(Boolean);
    // A document that has been round-tripped through several tools carries a
    // history stack; the number of entries is a rough edit count.
    meta.xmpHistoryEvents = (xmp.match(/<rdf:li[^>]*stEvt:action/g) || []).length || null;
  }

  meta.pageCount = Number(/\/Count\s+(\d+)/.exec(raw)?.[1]) || null;
  return meta;
}

/** PDF dates are D:YYYYMMDDHHmmSS+ZZ'zz'. Turn them into something readable. */
function pdfDate(v) {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(v);
  if (!m) return v;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}
