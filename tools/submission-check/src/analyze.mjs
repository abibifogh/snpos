import { extract } from './extract/index.mjs';
import { analyseHidden } from './analyze/hidden.mjs';
import { analyseProvenance } from './analyze/provenance.mjs';
import { analyseStyle } from './analyze/stylometry.mjs';
import { analyseLexical } from './analyze/lexical.mjs';
import { analyseCitations, verifyCitations } from './analyze/citations.mjs';
import { compareBatch } from './analyze/similarity.mjs';
import { score, bySeverity } from './score.mjs';
import { buildLocator, describeLocation } from './spans.mjs';
import { rewriteSentence } from './rewrite.mjs';
import { INVISIBLE } from './analyze/hidden.mjs';

/** Do these two read identically on the page, whatever the bytes say? */
function visuallySame(a, b) {
  const strip = (s) => String(s).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return strip(a) === strip(b);
}

/** Show invisible characters as a dot, the same way context snippets do. */
function mask(s) {
  return String(s).replace(INVISIBLE, '·');
}

/** Above this, a report stops being a list of edits and becomes a wall. */
const MAX_ANNOTATIONS = 250;

/**
 * Give every flagged string a place and, where we have one, a plainer version.
 *
 * The analysers deliberately know nothing about paragraphs or sentences; they
 * report offsets. Resolving those into coordinates happens once, here, so that
 * a PDF's page numbering and a Word document's paragraph numbering are applied
 * by the same code to findings from every analyser.
 */
function annotate(findings, text, locator) {
  const annotations = [];

  for (const finding of findings) {
    for (const o of finding.occurrences ?? []) {
      o.location = locator.locate(o.start);
      o.where = describeLocation(o.location);

      const sentence = locator.sentenceAt(o.start);
      if (sentence && o.suggestion) {
        o.before = sentence.text.replace(/\s+/g, ' ').trim();
        o.after = suggestedSentence(sentence, o);

        // Removing invisible characters leaves the sentence looking exactly as
        // it did. A before/after pair of two identical lines reads as a broken
        // report, so the pair is dropped and the instruction stands alone.
        if (o.after != null && visuallySame(o.before, o.after)) {
          o.after = null;
          o.noVisibleChange = true;
        }

        // Masked only after the comparison above, so the sameness test sees the
        // real characters. A quoted sentence that still contains them renders
        // as boxes in a terminal and as nothing at all on a page.
        o.before = mask(o.before);
        if (o.after != null) o.after = mask(o.after);
      }

      annotations.push({
        start: o.start,
        end: o.end,
        text: o.text,
        where: o.where,
        location: o.location,
        suggestion: o.suggestion,
        before: o.before,
        after: o.after,
        noVisibleChange: o.noVisibleChange ?? false,
        findingId: finding.id,
        severity: finding.severity,
        label: finding.title,
      });
    }
  }

  return dropContained(annotations).slice(0, MAX_ANNOTATIONS);
}

/**
 * Keep the widest span where several cover the same text.
 *
 * "plays a crucial role in" and "crucial" are both flagged, by different
 * checks, at overlapping positions. Left alone that shows the reader the same
 * problem twice and offers two rewrites, one of which ("crucial" → "important")
 * is strictly worse than the other now that the phrase-level fix is available.
 * The wider match is the more specific diagnosis, so it wins.
 */
function dropContained(annotations) {
  const sorted = [...annotations].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  for (const a of sorted) {
    const covered = kept.some((k) => a.start >= k.start && a.end <= k.end);
    if (!covered) kept.push(a);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * The sentence as it would read with the suggestion applied.
 *
 * Only the rewrite's own span is touched, never the whole of what was flagged,
 * and 'advise' returns nothing at all rather than a substitution that would
 * mangle the line.
 */
function suggestedSentence(sentence, o) {
  const { action } = o.suggestion;
  if (action === 'delete-sentence' || action === 'advise') return null;

  const replacement = action === 'delete' ? '' : o.suggestion.alternatives?.[0];
  if (replacement == null) return null;

  const start = (o.rewriteStart ?? o.start) - sentence.start;
  const end = (o.rewriteEnd ?? o.end) - sentence.start;
  if (start < 0 || end > sentence.text.length) return null;

  return rewriteSentence(sentence.text.replace(/\n/g, ' '), [{
    start,
    end,
    action: action === 'delete' ? 'delete' : 'replace',
    replacement,
  }]);
}

/**
 * Run every check over one submission.
 *
 * Extraction failures are returned rather than thrown: a batch of thirty
 * essays should not stop at the one file that was saved in a format nobody
 * expected, and the marker still needs to know that file was not checked.
 */
export async function analyseDocument(buffer, name, opts = {}) {
  let doc;
  try {
    doc = extract(buffer, name);
  } catch (err) {
    return {
      name,
      error: err.message,
      findings: [],
      scored: score([], {}),
      text: '',
      meta: {},
    };
  }

  const text = doc.text ?? '';
  const hidden = analyseHidden(text, doc.meta);
  const provenance = analyseProvenance(doc);
  const style = analyseStyle(text);
  const lexical = analyseLexical(text);
  const citations = analyseCitations(text);

  let citationVerification = null;
  if (opts.verifyCitations && citations.references.length) {
    citationVerification = await verifyCitations(citations.references, {
      email: opts.contactEmail,
      limit: opts.citationLimit ?? 25,
      ...(opts.apiBase ? { apiBase: opts.apiBase } : {}),
    });
  }

  const findings = bySeverity([
    ...hidden.findings,
    ...provenance.findings,
    ...lexical.findings,
    ...citations.findings,
    ...(citationVerification?.findings ?? []),
    ...style.findings,
  ]);

  const locator = buildLocator(text, { pageBreaks: doc.pageBreaks ?? [] });
  const annotations = annotate(findings, text, locator);

  return {
    name,
    kind: doc.kind,
    text,
    meta: doc.meta,
    facts: provenance.facts,
    findings,
    annotations,
    scored: score(findings, { styleReliable: style.reliable }),
    metrics: {
      ...style.metrics,
      ...lexical.metrics,
      ...citations.metrics,
      hiddenCharacters: hidden.counts,
    },
    styleNote: style.note,
    references: citations.references,
    citationVerification,
  };
}

/**
 * Analyse a set of submissions together.
 *
 * Cross-document comparison happens once, over the batch, and its findings are
 * attached back onto the documents they name so that a per-student report
 * still shows them.
 */
export async function analyseBatch(inputs, opts = {}) {
  const documents = [];
  for (const { buffer, name } of inputs) {
    documents.push(await analyseDocument(buffer, name, opts));
    opts.onProgress?.(documents.length, inputs.length, name);
  }

  const batch = documents.length >= 2
    ? compareBatch(documents.map((d) => ({ name: d.name, text: d.text, meta: d.meta })))
    : { findings: [], pairs: [] };

  for (const finding of batch.findings) {
    const named = finding.pair ?? finding.documents ?? [];
    for (const doc of documents) {
      if (!named.includes(doc.name)) continue;
      doc.findings = bySeverity([...doc.findings, finding]);
      doc.scored = score(doc.findings, { styleReliable: doc.metrics?.words >= 400 });
    }
  }

  return { documents, batch, generatedAt: new Date().toISOString() };
}
