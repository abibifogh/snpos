import { readZip, zipText } from '../zip.mjs';
import { attr, allAttrs, tagText, walkText, decodeEntities } from '../xml.mjs';

/**
 * Pull text and, more importantly, editing history out of a .docx.
 *
 * The text is what gets read for style. The history is what carries weight:
 * Word records how long a document was open, how many times it was saved, and
 * how many distinct editing sessions touched it. A document that was written
 * over a fortnight looks nothing like one that was pasted in and saved once,
 * and unlike style, that difference does not depend on how well the author
 * writes English.
 */

/** Word's own namespace-prefixed names, kept in one place. */
const PARA_END = new Set(['w:p']);
const BREAKS = new Set(['w:br', 'w:cr']);

export function extractDocx(buf) {
  const files = readZip(buf);
  const doc = zipText(files, 'word/document.xml');
  if (!doc) throw new Error('Not a Word document (word/document.xml is missing)');

  const text = documentText(doc);
  const core = zipText(files, 'docProps/core.xml');
  const app = zipText(files, 'docProps/app.xml');
  const settings = zipText(files, 'word/settings.xml');

  return {
    kind: 'docx',
    text,
    meta: {
      ...coreProps(core),
      ...appProps(app),
      ...revisionInfo(doc, settings),
      concealedRuns: concealedRuns(doc),
      embeddedFiles: [...files.keys()].filter((n) => /^word\/(embeddings|media)\//.test(n)).length,
      hasComments: files.has('word/comments.xml'),
      commentAuthors: [...new Set(allAttrs(zipText(files, 'word/comments.xml'), 'w:comment', 'w:author'))],
    },
    parts: [...files.keys()],
  };
}

/**
 * Text in document order, with paragraph and tab structure preserved.
 *
 * Field results (<w:instrText>) are dropped because they are formulae like
 * PAGE and TOC, not prose, and counting them as sentences would skew every
 * length statistic downwards. Deleted text under tracked changes is dropped
 * from the prose for the same reason but counted separately as evidence.
 */
function documentText(xml) {
  let skipDepth = 0;
  const out = walkText(xml, {
    keepText: (parent) => skipDepth === 0 && (parent === 'w:t' || parent === 'w:delText'),
    open(name) {
      if (name === 'w:instrText' || name === 'w:delText') skipDepth++;
      return '';
    },
    close(name) {
      if (name === 'w:instrText' || name === 'w:delText') skipDepth--;
      return PARA_END.has(name) ? '\n\n' : '';
    },
    empty(name) {
      if (name === 'w:tab') return '\t';
      if (BREAKS.has(name)) return '\n';
      return '';
    },
  });
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function coreProps(xml) {
  if (!xml) return {};
  return {
    title: tagText(xml, 'dc:title'),
    author: tagText(xml, 'dc:creator'),
    lastModifiedBy: tagText(xml, 'cp:lastModifiedBy'),
    created: tagText(xml, 'dcterms:created'),
    modified: tagText(xml, 'dcterms:modified'),
    revisionCount: numeric(tagText(xml, 'cp:revision')),
    lastPrinted: tagText(xml, 'cp:lastPrinted'),
  };
}

function appProps(xml) {
  if (!xml) return {};
  return {
    application: tagText(xml, 'Application'),
    appVersion: tagText(xml, 'AppVersion'),
    company: tagText(xml, 'Company'),
    template: tagText(xml, 'Template'),
    // TotalTime is minutes the document spent open in Word. It is the single
    // most useful number in the file: a 3000-word essay with a total editing
    // time of 1 minute was not typed, it was pasted.
    editingMinutes: numeric(tagText(xml, 'TotalTime')),
    words: numeric(tagText(xml, 'Words')),
    characters: numeric(tagText(xml, 'Characters')),
    paragraphs: numeric(tagText(xml, 'Paragraphs')),
    pages: numeric(tagText(xml, 'Pages')),
  };
}

/**
 * Revision Save IDs, Word's per-session fingerprint.
 *
 * Word stamps every run of text with the id of the editing session that
 * produced it, and mints a new id each time the document is opened and saved.
 * The count of distinct ids across the body is therefore a lower bound on the
 * number of sittings the document was written across. One id means one sitting.
 */
function revisionInfo(doc, settings) {
  const sessionIds = new Set(allAttrs(settings, 'w:rsid', 'w:val'));
  const used = new Set();
  for (const a of ['w:rsidR', 'w:rsidRDefault', 'w:rsidP', 'w:rsidRPr']) {
    for (const v of allAttrs(doc, 'w:p', a)) used.add(v);
  }
  const insertions = (doc.match(/<w:ins\b/g) || []).length;
  const deletions = (doc.match(/<w:del\b/g) || []).length;

  return {
    editingSessions: sessionIds.size || used.size || null,
    trackedInsertions: insertions,
    trackedDeletions: deletions,
    trackedAuthors: [...new Set([...allAttrs(doc, 'w:ins', 'w:author'), ...allAttrs(doc, 'w:del', 'w:author')])],
    // A doc that was pasted from a web page keeps the source in a hyperlink
    // relationship or a comment; worth surfacing verbatim.
    hyperlinks: extractHyperlinks(doc),
  };
}

/**
 * Text that is in the document but cannot be seen when reading it.
 *
 * Word can hide a run outright (w:vanish), paint it the same colour as the
 * page, or set it to a size too small to read. All three are legitimate
 * occasionally, index entries and hidden notes exist, but all three are also
 * how an instruction to an automated marker gets smuggled into an essay. The
 * run's text is returned so the reader can judge which of the two it is.
 *
 * Sizes are in half-points, so w:sz 4 is 2pt.
 */
function concealedRuns(doc) {
  const out = [];
  for (const m of doc.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
    const run = m[1];
    const props = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? '';
    if (!props) continue;

    const colour = attr(/<w:color\b[^>]*>/.exec(props)?.[0] ?? '', 'w:val');
    const size = Number(attr(/<w:sz\b[^>]*>/.exec(props)?.[0] ?? '', 'w:val'));
    const highlight = attr(/<w:highlight\b[^>]*>/.exec(props)?.[0] ?? '', 'w:val');

    let reason = null;
    if (/<w:vanish\b/.test(props) && !/<w:specVanish\b/.test(props)) reason = 'marked hidden';
    else if (colour && isNearWhite(colour) && highlight !== 'yellow') reason = `white text (#${colour})`;
    else if (Number.isFinite(size) && size > 0 && size <= 4) reason = `${size / 2}pt text`;
    if (!reason) continue;

    const text = [...run.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((t) => decodeEntities(t[1]))
      .join('');
    if (text.trim().length < 2) continue;

    out.push({ reason, text: text.trim() });
  }

  // Adjacent runs are usually one sentence split by formatting; merge them so
  // the reader sees the whole hidden instruction, not a dozen fragments.
  return mergeRuns(out).slice(0, 10);
}

function isNearWhite(hex) {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return r > 235 && g > 235 && b > 235;
}

function mergeRuns(runs) {
  const out = [];
  for (const run of runs) {
    const prev = out[out.length - 1];
    if (prev && prev.reason === run.reason) prev.text += ` ${run.text}`;
    else out.push({ ...run });
  }
  return out;
}

function extractHyperlinks(doc) {
  const anchors = allAttrs(doc, 'w:hyperlink', 'w:anchor');
  const urls = [...doc.matchAll(/<w:instrText[^>]*>\s*HYPERLINK\s+"([^"]+)"/g)].map((m) => decodeEntities(m[1]));
  return [...new Set([...urls, ...anchors.filter((a) => /^https?:/.test(a))])];
}

function numeric(v) {
  if (v == null) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

export { documentText as _documentText };
