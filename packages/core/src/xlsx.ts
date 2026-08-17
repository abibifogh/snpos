/**
 * Reading an .xlsx without a library.
 *
 * Every other upload in this system takes CSV, and every time somebody is told
 * "save it as CSV first" is a step where the wrong sheet gets exported, the
 * decimal separator changes, or the file simply never arrives. A stock count is
 * the worst place for that: it is done once, by somebody holding a clipboard,
 * and if the upload is awkward they will type four hundred lines by hand
 * instead.
 *
 * An .xlsx is a ZIP of XML. Both halves of that are now available without a
 * dependency — `DecompressionStream` handles the ZIP's deflate, and the XML we
 * need is a narrow enough shape to read directly. So this is about a hundred
 * lines instead of a package, and nothing here can drift out of date.
 *
 * What it deliberately does NOT do: formulas, dates, styles, multiple sheets
 * beyond the first. A count sheet is text and numbers in a grid. Anything
 * cleverer is a spreadsheet being used as a database, which is the thing this
 * system exists to replace.
 */

/** Everything read back as text, in the same shape the CSV parser returns. */
export type Grid = string[][];

const dec = new TextDecoder();

/* ------------------------------------------------------------------ the zip */

interface ZipEntry { name: string; method: number; start: number; size: number }

/**
 * The central directory, read from the end backwards.
 *
 * Scanning local headers forwards looks simpler and is wrong: a file written by
 * a streaming writer puts the sizes AFTER the data, so the header says zero and
 * the reader walks off the end. The central directory is the copy that is
 * always complete.
 */
function entriesOf(buf: Uint8Array): ZipEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // End of central directory: signature, then the offset of the directory.
  // Searched from the back because a comment may follow it.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65_558; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That file is not a spreadsheet the reader understands.');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = dec.decode(buf.subarray(at + 46, at + 46 + nameLen));

    // The local header's own name and extra lengths, which differ from the
    // directory's. Using the directory's here reads from the wrong offset.
    const localNameLen = view.getUint16(localAt + 26, true);
    const localExtraLen = view.getUint16(localAt + 28, true);
    out.push({ name, method, size, start: localAt + 30 + localNameLen + localExtraLen });

    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflate(bytes: Uint8Array, method: number): Promise<string> {
  if (method === 0) return dec.decode(bytes);
  if (method !== 8) throw new Error('That spreadsheet uses a compression this reader does not know.');
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return dec.decode(new Uint8Array(await new Response(stream).arrayBuffer()));
}

/* ------------------------------------------------------------------ the xml */

const unescape = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    // Last, or an escaped ampersand becomes the start of another entity.
    .replace(/&amp;/g, '&');

/** The text of every `<t>` in one element, joined. A styled cell splits into runs. */
const textIn = (xml: string) =>
  [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join('');

function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => textIn(m[1]));
}

/** "BC" is column 55. Needed so a blank cell keeps its place rather than shifting the row left. */
function columnOf(ref: string): number {
  const letters = ref.replace(/[^A-Z]/gi, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetGrid(xml: string, strings: string[]): Grid {
  const rows: Grid = [];

  for (const rowMatch of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of rowMatch[1].matchAll(/<c\s([^>]*?)\/>|<c\s([^>]*?)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1] ?? cell[2] ?? '';
      const body = cell[3] ?? '';
      const at = columnOf(/r="([^"]+)"/.exec(attrs)?.[1] ?? '');
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';

      let value = '';
      if (type === 's') {
        const idx = Number(/<v[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        value = strings[idx] ?? '';
      } else if (type === 'inlineStr') {
        value = textIn(body);
      } else {
        value = unescape(/<v[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }

      if (at >= 0) {
        while (cells.length < at) cells.push('');
        cells[at] = value;
      } else cells.push(value);
    }
    rows.push(cells);
  }

  // Trailing empty rows, which Excel adds freely when somebody has clicked
  // about below the data.
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

/* ----------------------------------------------------------------- together */

export async function readXlsx(data: ArrayBuffer): Promise<Grid> {
  const buf = new Uint8Array(data);
  const entries = entriesOf(buf);

  const read = async (name: string) => {
    const e = entries.find((x) => x.name === name);
    if (!e) return '';
    return inflate(buf.subarray(e.start, e.start + e.size), e.method);
  };

  const strings = sharedStrings(await read('xl/sharedStrings.xml'));

  // The first sheet by position in the archive, not by a name — a workbook
  // whose first tab was renamed still has its data in sheet1.xml, and a
  // workbook where somebody deleted the first tab does not.
  const sheet = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
  if (!sheet) throw new Error('That spreadsheet has no sheets in it.');

  return sheetGrid(await inflate(buf.subarray(sheet.start, sheet.start + sheet.size), sheet.method), strings);
}

/** True for a file whose bytes begin "PK", which every .xlsx does. */
export const looksLikeXlsx = (data: ArrayBuffer): boolean => {
  const b = new Uint8Array(data, 0, Math.min(2, data.byteLength));
  return b[0] === 0x50 && b[1] === 0x4b;
};
