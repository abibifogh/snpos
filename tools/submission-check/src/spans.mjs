/**
 * Turning a character offset into somewhere a person can look.
 *
 * "Elevated rate of assistant-favoured vocabulary" is not something a student
 * can be shown. "Paragraph 4, second sentence" is. Everything the analysers
 * flag carries the offset it was found at, and this module converts that into
 * the coordinates the reader actually has in front of them: paragraph and
 * sentence for a word processor, page as well for a PDF.
 *
 * Offsets are into the extracted text, so they only stay true if nothing
 * reformats that text afterwards. That is why the extractors normalise
 * whitespace before offsets are ever taken, rather than after.
 */

/** Abbreviations that end in a full stop without ending a sentence. */
const ABBREVIATIONS = /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|cf|al|fig|no|vol|pp|ed|approx|dept|univ)\.$/i;

/**
 * Sentence boundaries, as offsets into the original string.
 *
 * The rules match the ones the style metrics use, and for the same reason:
 * splitting "Dr. Mensah" in two would both fabricate a short sentence for the
 * burstiness measure and point the reader at the wrong half of a line.
 */
export function sentenceSpans(text) {
  const spans = [];
  // A blank line ends a sentence as surely as a full stop does. Without this,
  // a heading carrying no punctuation ("## Introduction") swallows the first
  // sentence of the paragraph below it, and every position reported inside
  // that sentence then belongs to the wrong paragraph.
  const re = /[.!?]+["'”’)\]]*(?=\s|$)|\n[ \t]*\n/g;
  let start = 0;
  let m;

  while ((m = re.exec(text))) {
    if (m[0].startsWith('\n')) {
      if (text.slice(start, m.index).trim()) {
        spans.push({ start: start + leadingSpace(text.slice(start, m.index)), end: m.index });
      }
      start = m.index + m[0].length;
      continue;
    }

    const end = m.index + m[0].length;
    const candidate = text.slice(start, end);
    const trimmed = candidate.trimEnd();

    if (ABBREVIATIONS.test(trimmed)) continue;
    if (/\b\p{Lu}\.$/u.test(trimmed)) continue;                       // an initial: "K. Mensah"
    if (/\d\.$/.test(trimmed) && /^\s*\d/.test(text.slice(end))) continue; // a decimal split across the stop

    if (trimmed.trim()) spans.push({ start: start + leadingSpace(candidate), end });
    start = end;
  }

  const tail = text.slice(start);
  if (tail.trim()) spans.push({ start: start + leadingSpace(tail), end: text.length });
  return spans;
}

/** Paragraph boundaries, as offsets. Blank lines separate paragraphs. */
export function paragraphSpans(text) {
  const spans = [];
  const re = /\n\s*\n/g;
  let start = 0;
  let m;

  while ((m = re.exec(text))) {
    if (text.slice(start, m.index).trim()) {
      spans.push({ start: start + leadingSpace(text.slice(start, m.index)), end: m.index });
    }
    start = m.index + m[0].length;
  }
  if (text.slice(start).trim()) {
    spans.push({ start: start + leadingSpace(text.slice(start)), end: text.length });
  }
  return spans;
}

/**
 * A locator over one document.
 *
 * Built once and queried many times, so the spans are computed up front and
 * each lookup is a binary search rather than a rescan.
 */
export function buildLocator(text, { pageBreaks = [] } = {}) {
  const sentences = sentenceSpans(text);
  const paragraphs = paragraphSpans(text);
  const pages = [...pageBreaks].sort((a, b) => a - b);

  return {
    sentences,
    paragraphs,

    /** Where is this offset? One-based, because nobody counts paragraphs from zero. */
    locate(offset) {
      const paragraph = indexOfSpan(paragraphs, offset);
      const sentence = indexOfSpan(sentences, offset);
      const page = pages.length ? countBefore(pages, offset) : null;

      // The sentence ordinal is only reported when the sentence begins in the
      // paragraph being named. Falling back to a document-wide count would put
      // two different numbering schemes behind one label, and "paragraph 3,
      // sentence 3" would sometimes mean the third sentence of the document.
      const within = paragraph >= 0 ? sentencesWithin(sentences, paragraphs[paragraph]) : [];
      const position = within.indexOf(sentence);

      return {
        paragraph: paragraph >= 0 ? paragraph + 1 : null,
        sentence: position >= 0 ? position + 1 : null,
        documentSentence: sentence >= 0 ? sentence + 1 : null,
        page,
        totalParagraphs: paragraphs.length,
      };
    },

    /** The whole sentence containing an offset, for showing a rewrite in context. */
    sentenceAt(offset) {
      const i = indexOfSpan(sentences, offset);
      return i >= 0 ? { ...sentences[i], text: text.slice(sentences[i].start, sentences[i].end) } : null;
    },
  };
}

/** Human phrasing for a location, used identically by both report formats. */
export function describeLocation(loc) {
  if (!loc) return null;
  const parts = [];
  if (loc.page) parts.push(`page ${loc.page}`);
  if (loc.paragraph) parts.push(`paragraph ${loc.paragraph}`);
  if (loc.sentence) parts.push(`sentence ${loc.sentence}`);
  return parts.length ? parts.join(', ') : null;
}

function leadingSpace(s) {
  return s.length - s.trimStart().length;
}

/** The span containing an offset, or the one it falls just after. */
function indexOfSpan(spans, offset) {
  let lo = 0;
  let hi = spans.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].start <= offset) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

function countBefore(breaks, offset) {
  let n = 0;
  for (const b of breaks) if (b <= offset) n++;
  return n || 1;
}

function sentencesWithin(sentences, paragraph) {
  const out = [];
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].start >= paragraph.start && sentences[i].start < paragraph.end) out.push(i);
  }
  return out;
}
