import { deflateRawSync, crc32 } from 'node:zlib';

/**
 * A minimal ZIP writer, used only to build test fixtures.
 *
 * The tool itself only ever reads ZIPs. Building them here means the tests
 * exercise the real reader against real archives rather than against a mock of
 * one, which is the only way to know the header arithmetic is right.
 */
export function makeZip(entries, { compress = true } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, contentRaw] of Object.entries(entries)) {
    const content = Buffer.isBuffer(contentRaw) ? contentRaw : Buffer.from(contentRaw, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = compress ? deflateRawSync(content) : content;
    const method = compress ? 8 : 0;
    const crc = crc32(content);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0, 6);        // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    const dir = Buffer.alloc(46 + nameBuf.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(content.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    nameBuf.copy(dir, 46);

    locals.push(local, deflated);
    central.push(dir);
    offset += local.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** A .docx whose body is the given paragraphs, plus whatever metadata is asked for. */
export function makeDocx(paragraphs, { editingMinutes = 30, revision = 4, created, modified, author, lastModifiedBy, application = 'Microsoft Office Word', extraRuns = '', rsids = ['00A1B2C3'] } = {}) {
  const body = paragraphs
    .map((p, i) => `<w:p w:rsidR="${rsids[i % rsids.length]}"><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`)
    .join('');

  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml':
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
      + `<w:body>${body}${extraRuns}</w:body></w:document>`,
    'word/settings.xml':
      `<?xml version="1.0"?><w:settings xmlns:w="x"><w:rsids>`
      + rsids.map((r) => `<w:rsid w:val="${r}"/>`).join('')
      + `</w:rsids></w:settings>`,
    'docProps/core.xml':
      `<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y" xmlns:dcterms="z">`
      + (author ? `<dc:creator>${escapeXml(author)}</dc:creator>` : '')
      + (lastModifiedBy ? `<cp:lastModifiedBy>${escapeXml(lastModifiedBy)}</cp:lastModifiedBy>` : '')
      + (created ? `<dcterms:created>${created}</dcterms:created>` : '')
      + (modified ? `<dcterms:modified>${modified}</dcterms:modified>` : '')
      + `<cp:revision>${revision}</cp:revision></cp:coreProperties>`,
    'docProps/app.xml':
      `<?xml version="1.0"?><Properties><Application>${escapeXml(application)}</Application>`
      + `<TotalTime>${editingMinutes}</TotalTime>`
      + `<Words>${paragraphs.join(' ').split(/\s+/).length}</Words></Properties>`,
  });
}

/** A hidden run: white text, a tiny font, or explicitly marked hidden. */
export function concealedRun(text, kind = 'white') {
  const props = {
    white: '<w:color w:val="FFFFFF"/>',
    tiny: '<w:sz w:val="2"/>',
    vanish: '<w:vanish/>',
  }[kind];
  return `<w:p><w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** A .xlsx with the given rows of literal values, and optionally some formulas. */
export function makeXlsx(values, formulas = []) {
  const strings = values.filter((v) => typeof v === 'string');
  const cells = values.map((v, i) => {
    const ref = `A${i + 1}`;
    return typeof v === 'string'
      ? `<c r="${ref}" t="s"><v>${strings.indexOf(v)}</v></c>`
      : `<c r="${ref}"><v>${v}</v></c>`;
  }).join('');
  const formulaCells = formulas.map((f, i) => `<c r="B${i + 1}"><f>${escapeXml(f)}</f><v>0</v></c>`).join('');

  return makeZip({
    'xl/workbook.xml': '<?xml version="1.0"?><workbook><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet><sheetData><row>${cells}${formulaCells}</row></sheetData></worksheet>`,
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst>${strings.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join('')}</sst>`,
    'docProps/app.xml': '<?xml version="1.0"?><Properties><Application>Microsoft Excel</Application><TotalTime>15</TotalTime></Properties>',
    'docProps/core.xml': '<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y"><cp:revision>3</cp:revision></cp:coreProperties>',
  });
}

/**
 * A small, valid, uncompressed PDF with one text-bearing content stream.
 * Built by hand so the extractor is tested against real PDF syntax.
 */
export function makePdf(lines, { producer = 'Test Suite', creator = null } = {}) {
  const content = `BT /F1 12 Tf 72 720 Td\n${
    lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n')
  }\nET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Producer (${producer})${creator ? ` /Creator (${creator})` : ''} /CreationDate (D:20260101120000Z) >>`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

function escapeXml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** Filler prose long enough for the length gates in the analysers to open. */
export function filler(words, seed = 'the argument develops across several distinct stages of reasoning and evidence') {
  const pool = seed.split(' ');
  const out = [];
  for (let i = 0; i < words; i++) out.push(pool[(i * 7 + 3) % pool.length]);
  return `${out.join(' ')}.`;
}
