/** The one-line description of a document, shared by both report formats. */
export function summaryParts(doc) {
  return [
    doc.kind,
    count(doc.metrics?.words, 'word'),
    count(doc.metrics?.sentences, 'sentence'),
    count(doc.metrics?.referenceCount, 'reference'),
  ].filter(Boolean);
}

export function count(n, noun, plural = `${noun}s`) {
  if (!n) return null;
  return `${n.toLocaleString()} ${n === 1 ? noun : plural}`;
}
