import { extractDocx } from './docx.mjs';
import { extractXlsx } from './xlsx.mjs';
import { extractPdf } from './pdf.mjs';
import { readZip, zipText } from '../zip.mjs';
import { walkText, tagText } from '../xml.mjs';

/**
 * Work out what a file actually is and hand it to the right reader.
 *
 * The extension is a hint, not evidence. Students rename files, export from
 * Google Docs, and submit a PDF called essay.docx often enough that sniffing
 * the leading bytes is the only reliable route. A wrong guess here would send
 * a perfectly good submission down the "unreadable" path.
 */
export function extract(buf, filename = '') {
  const kind = sniff(buf, filename);

  switch (kind) {
    case 'pdf': return extractPdf(buf);
    case 'ooxml': return extractOoxml(buf);
    case 'odf': return extractOdf(buf);
    case 'text': return extractPlain(buf, filename);
    case 'legacy-office':
      throw new Error(
        'Legacy Office format (.doc/.xls, pre-2007). These store no editing history that this tool can read, ' +
        'and the text is in a binary record stream. Ask for it again as .docx/.xlsx or PDF.',
      );
    case 'rtf': return extractRtf(buf);
    default:
      throw new Error(`Unrecognised file type${filename ? ` for ${filename}` : ''} (first bytes: ${buf.subarray(0, 8).toString('hex')})`);
  }
}

function sniff(buf, filename) {
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';

  // Both OOXML and ODF are ZIPs; the mimetype entry or the part names separate them.
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const head = buf.subarray(0, 4096).toString('latin1');
    if (head.includes('mimetype') && head.includes('opendocument')) return 'odf';
    return 'ooxml';
  }

  // OLE2 compound file: the old .doc/.xls/.ppt container.
  if (buf.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') return 'legacy-office';

  if (['txt', 'md', 'markdown', 'csv', 'tsv'].includes(ext)) return 'text';
  if (isMostlyText(buf)) return 'text';
  return 'unknown';
}

function isMostlyText(buf) {
  const sample = buf.subarray(0, 4096);
  if (!sample.length) return false;
  let printable = 0;
  for (const b of sample) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127)) printable++;
  return printable / sample.length > 0.9;
}

/** A ZIP of OOXML: decide between Word and Excel by which parts are present. */
function extractOoxml(buf) {
  const files = readZip(buf);
  if (files.has('word/document.xml')) return extractDocx(buf);
  if ([...files.keys()].some((n) => n.startsWith('xl/'))) return extractXlsx(buf);
  if ([...files.keys()].some((n) => n.startsWith('ppt/'))) {
    throw new Error('PowerPoint files are not supported yet; export the deck to PDF and submit that.');
  }
  throw new Error('ZIP archive, but not a Word or Excel document.');
}

/** OpenDocument (LibreOffice, and Google Docs when exported as .odt). */
function extractOdf(buf) {
  const files = readZip(buf);
  const content = zipText(files, 'content.xml');
  const metaXml = zipText(files, 'meta.xml');

  const text = walkText(content, {
    keepText: (parent) => parent === 'text:p' || parent === 'text:span' || parent === 'text:h',
    close: (name) => (name === 'text:p' || name === 'text:h' ? '\n\n' : ''),
    empty: (name) => (name === 'text:tab' ? '\t' : name === 'text:line-break' ? '\n' : ''),
  });

  return {
    kind: 'odt',
    text: text.replace(/\n{3,}/g, '\n\n').trim(),
    meta: {
      title: tagText(metaXml, 'dc:title'),
      author: tagText(metaXml, 'meta:initial-creator') || tagText(metaXml, 'dc:creator'),
      lastModifiedBy: tagText(metaXml, 'dc:creator'),
      created: tagText(metaXml, 'meta:creation-date'),
      modified: tagText(metaXml, 'dc:date'),
      revisionCount: Number(tagText(metaXml, 'meta:editing-cycles')) || null,
      application: tagText(metaXml, 'meta:generator'),
      // ODF records duration as an ISO-8601 period, PT1H23M0S.
      editingMinutes: isoDurationToMinutes(tagText(metaXml, 'meta:editing-duration')),
    },
    parts: [...files.keys()],
  };
}

function isoDurationToMinutes(v) {
  if (!v) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(v);
  if (!m) return null;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return Math.round(Number(d) * 1440 + Number(h) * 60 + Number(min) + Number(s) / 60);
}

function extractPlain(buf, filename) {
  return { kind: 'text', text: stripBom(buf.toString('utf8')).trim(), meta: { filename }, parts: [] };
}

/**
 * RTF, minimally. Enough to get the prose out; RTF carries no edit history.
 */
function extractRtf(buf) {
  const raw = buf.toString('latin1');
  const text = raw
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\s?\??/g, (_, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
    .replace(/\\[a-z]+-?\d*\s?/gi, '')
    .replace(/[{}]/g, '');
  return { kind: 'rtf', text: text.replace(/\n{3,}/g, '\n\n').trim(), meta: {}, parts: [] };
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
