/**
 * Comparing a batch against itself.
 *
 * This is often the most useful thing in the tool, and it is the part that has
 * nothing to do with AI. Marking thirty essays, the question that actually
 * gets answered here is which two students handed in the same work, and which
 * files came off the same machine. Both are measurable exactly rather than
 * inferred, which puts them on much firmer ground than anything stylometric.
 *
 * There is a floor effect to respect: essays on one prompt share the prompt's
 * vocabulary, so a baseline of overlap is normal and expected. What matters is
 * a pair standing well clear of the rest of the cohort, which is why the
 * threshold is computed from the batch rather than fixed.
 */

const SHINGLE = 5;

export function compareBatch(documents) {
  const usable = documents.filter((d) => d.text && d.text.split(/\s+/).length >= 80);
  const findings = [];
  const pairs = [];

  if (usable.length >= 2) {
    const profiles = usable.map((d) => ({ doc: d, shingles: shingles(d.text) }));

    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const a = profiles[i];
        const b = profiles[j];
        const shared = intersectionSize(a.shingles, b.shingles);
        if (!shared) continue;

        const union = a.shingles.size + b.shingles.size - shared;
        pairs.push({
          a: a.doc.name,
          b: b.doc.name,
          jaccard: shared / union,
          // Containment catches the asymmetric case: a short essay copied
          // wholesale into a longer one has low Jaccard but containment near 1.
          containment: shared / Math.min(a.shingles.size, b.shingles.size),
          sharedPhrases: shared,
        });
      }
    }

    pairs.sort((x, y) => y.containment - x.containment);

    const values = pairs.map((p) => p.containment);
    const baseline = median(values);
    const spread = median(values.map((v) => Math.abs(v - baseline))) || 0.01;

    for (const pair of pairs) {
      // Flag on either an absolute level that is hard to reach honestly, or a
      // clear outlier against how much this particular cohort overlaps.
      const outlier = pair.containment > baseline + 6 * spread;
      const absolute = pair.containment >= 0.35;
      if (!outlier && !absolute) continue;

      findings.push({
        id: 'batch.similarity',
        severity: pair.containment >= 0.6 ? 'critical' : pair.containment >= 0.35 ? 'high' : 'medium',
        title: `${pct(pair.containment)} of the shorter document's phrasing also appears in the other`,
        detail: `${pair.a} and ${pair.b} share ${pair.sharedPhrases.toLocaleString()} exact ${SHINGLE}-word sequences `
          + `(overlap ${pct(pair.jaccard)}). The rest of this batch overlaps at around ${pct(baseline)}, so this pair `
          + 'stands apart. Shared sources, a common template or a group task all explain some of this; read the two '
          + 'side by side before concluding anything.',
        pair: [pair.a, pair.b],
      });
      if (findings.length >= 20) break;
    }
  }

  findings.push(...sharedMetadata(documents));

  return { findings, pairs: pairs.slice(0, 50) };
}

/**
 * Files from different students that carry the same machine's fingerprints.
 *
 * Author names in Office metadata come from the installed copy of Word, so two
 * submissions naming the same author were typed on the same machine or from the
 * same file. In a computer lab that is meaningless; on personal laptops it is not.
 */
function sharedMetadata(documents) {
  const findings = [];
  const groups = new Map();

  for (const doc of documents) {
    for (const [field, label] of [['author', 'author'], ['lastModifiedBy', 'last-saved-by'], ['company', 'company']]) {
      const value = doc.meta?.[field];
      if (!value || !String(value).trim()) continue;
      const key = `${label}:${String(value).trim().toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, { label, value: String(value).trim(), docs: [] });
      groups.get(key).docs.push(doc.name);
    }
  }

  for (const group of groups.values()) {
    const unique = [...new Set(group.docs)];
    if (unique.length < 2) continue;
    // A default or empty-ish value carries no information about who typed it.
    if (/^(user|admin|windows user|hp|dell|student|owner|guest|pc|acer|lenovo|toshiba|asus|microsoft office user)$/i.test(group.value)) continue;

    findings.push({
      id: 'batch.shared-metadata',
      severity: unique.length >= 4 ? 'high' : 'medium',
      title: `${unique.length} submissions share the ${group.label} "${group.value}"`,
      detail: 'Office writes this from the copy of Word that saved the file. Submissions from different students '
        + 'carrying the same name were produced on one machine, or from one original. Shared or lab computers explain '
        + 'this entirely; personal laptops do not.',
      documents: unique,
    });
  }

  // The same producing tool across a whole batch is normal. The same
  // *timestamp* is not: it means one file was copied and refiled.
  const created = new Map();
  for (const doc of documents) {
    const t = doc.meta?.created;
    if (!t) continue;
    if (!created.has(t)) created.set(t, []);
    created.get(t).push(doc.name);
  }
  for (const [time, names] of created) {
    const unique = [...new Set(names)];
    if (unique.length < 2) continue;
    findings.push({
      id: 'batch.shared-timestamp',
      severity: 'high',
      title: `${unique.length} submissions were created at exactly the same moment (${time})`,
      detail: 'Identical creation timestamps to the second means these files descend from one original: it was copied, '
        + 'renamed and edited rather than each being started fresh.',
      documents: unique,
    });
  }

  return findings;
}

/**
 * Overlapping word n-grams, hashed to 32-bit integers.
 *
 * Storing the strings themselves would hold the whole cohort's text in memory
 * several times over; the hash keeps a batch of a hundred essays comfortable.
 * Collisions are possible and harmless here, since a single spurious shared
 * shingle cannot move a percentage built from thousands.
 */
function shingles(text) {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);
  const out = new Set();
  for (let i = 0; i + SHINGLE <= words.length; i++) {
    out.add(hash(words.slice(i, i + SHINGLE).join(' ')));
  }
  return out;
}

/** FNV-1a: fast, and good enough for set membership. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function intersectionSize(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const x of small) if (large.has(x)) n++;
  return n;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}
