import { readZip, zipText } from '../zip.mjs';
import { tagText, allAttrs, decodeEntities } from '../xml.mjs';

/**
 * Read a spreadsheet's text, and the thing that actually matters in a
 * spreadsheet submission: whether the numbers are computed or typed.
 *
 * Prose statistics are close to meaningless on a workbook, most cells are one
 * or two words. What distinguishes work from a paste is the formula layer. A
 * model asked for a budget will usually emit a grid of literal values, because
 * it computed them in its head; a student building a budget in Excel leaves
 * =SUM() behind. A workbook of 400 numbers and no formulas is worth a question.
 */
export function extractXlsx(buf) {
  const files = readZip(buf);
  const sheetNames = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  if (!sheetNames.length && !files.has('xl/workbook.xml')) {
    throw new Error('Not an Excel workbook (no xl/worksheets found)');
  }

  const shared = sharedStrings(zipText(files, 'xl/sharedStrings.xml'));
  const app = zipText(files, 'docProps/app.xml');
  const core = zipText(files, 'docProps/core.xml');

  let formulaCells = 0;
  let valueCells = 0;
  const chunks = [];
  const formulas = [];

  for (const name of sheetNames) {
    const xml = zipText(files, name);
    for (const m of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const cellAttrs = m[1];
      const body = m[2];
      const type = /\st="([^"]*)"/.exec(cellAttrs)?.[1];

      const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body);
      if (f || /<f\b[^>]*\/>/.test(body)) {
        formulaCells++;
        if (f && formulas.length < 50) formulas.push(decodeEntities(f[1]));
      }

      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      const inline = /<is>([\s\S]*?)<\/is>/.exec(body);

      if (type === 's' && v) {
        chunks.push(shared[Number(v[1])] ?? '');
        valueCells++;
      } else if (inline) {
        chunks.push(decodeEntities(inline[1].replace(/<[^>]*>/g, '')));
        valueCells++;
      } else if (v) {
        valueCells++;
        // Numbers are not prose; they are counted but kept out of the text so
        // they do not distort sentence and vocabulary statistics.
        if (type === 'str') chunks.push(decodeEntities(v[1]));
      }
    }
  }

  return {
    kind: 'xlsx',
    text: chunks.filter(Boolean).join('\n').trim(),
    meta: {
      title: tagText(core, 'dc:title'),
      author: tagText(core, 'dc:creator'),
      lastModifiedBy: tagText(core, 'cp:lastModifiedBy'),
      created: tagText(core, 'dcterms:created'),
      modified: tagText(core, 'dcterms:modified'),
      revisionCount: Number(tagText(core, 'cp:revision')) || null,
      application: tagText(app, 'Application'),
      appVersion: tagText(app, 'AppVersion'),
      company: tagText(app, 'Company'),
      editingMinutes: Number(tagText(app, 'TotalTime')) || null,
      sheets: allAttrs(zipText(files, 'xl/workbook.xml'), 'sheet', 'name'),
      formulaCells,
      valueCells,
      sampleFormulas: formulas.slice(0, 10),
      hasCharts: [...files.keys()].some((n) => n.startsWith('xl/charts/')),
      hasPivotTables: [...files.keys()].some((n) => n.includes('pivotTable')),
    },
    parts: [...files.keys()],
  };
}

/** The shared string table, in index order; Excel points cells at it by number. */
function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    // A run-split string (<r><t>Hel</t></r><r><t>lo</t></r>) must be joined
    // with nothing between the runs, or every formatting change becomes a
    // spurious word boundary.
    decodeEntities(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<[^>]*>/g, '')),
  );
}
