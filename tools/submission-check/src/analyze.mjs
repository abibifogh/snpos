import { extract } from './extract/index.mjs';
import { analyseHidden } from './analyze/hidden.mjs';
import { analyseProvenance } from './analyze/provenance.mjs';
import { analyseStyle } from './analyze/stylometry.mjs';
import { analyseLexical } from './analyze/lexical.mjs';
import { analyseCitations, verifyCitations } from './analyze/citations.mjs';
import { compareBatch } from './analyze/similarity.mjs';
import { score, bySeverity } from './score.mjs';

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

  return {
    name,
    kind: doc.kind,
    text,
    meta: doc.meta,
    facts: provenance.facts,
    findings,
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
