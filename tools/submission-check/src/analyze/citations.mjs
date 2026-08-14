/**
 * References, and whether they hang together.
 *
 * This is the check that most often produces something a student cannot talk
 * their way out of, and it has nothing to do with writing style. Language
 * models generate citations that look right, because a plausible-looking
 * citation is exactly what a language model is good at, and the authors,
 * journal and year are frequently assembled rather than recalled. The failures
 * that follow are structural: a work cited in the text that never reaches the
 * reference list, a DOI whose syntax is wrong, a volume number for a year the
 * journal had not started publishing.
 *
 * Everything here works offline. Actually confirming a reference exists needs
 * the network, so that is a separate opt-in pass against Crossref, off by
 * default: a marking tool should not silently send coursework to a third party.
 */

const HEADINGS = /^\s*(?:references|bibliography|works cited|reference list|sources)\s*:?\s*$/im;

/**
 * Anything parenthetical containing a year. The group is then split on
 * semicolons, because a single parenthesis routinely carries several works:
 * (Mensah, 2019; Owusu, 2020; Adjei et al., 2021, p. 14). Reading only the
 * first would leave the other two looking uncited, which is precisely the
 * false accusation this check must not manufacture.
 */
const PAREN_GROUP = /\(([^()]{3,400})\)/g;
const ONE_CITE = /^([\p{Lu}][\p{L}'’.\-]*(?:\s+(?:and|&|et)\s+[\p{L}'’.\-]+)*(?:\s+al\.?)?)\s*,?\s*\(?((?:19|20)\d{2})[a-z]?/u;
/** Prefixes that introduce a citation without being part of the name. */
const CITE_PREFIX = /^(?:e\.g\.|eg|i\.e\.|see also|see|cf\.|cf|also|but see|as cited in|in|from|adapted from|reviewed in)\s+/i;
/** Mensah (2019) */
const NARRATIVE_CITE = /\b([A-Z][\p{L}'’-]+(?:\s+(?:and|&)\s+[A-Z][\p{L}'’-]+|\s+et\s+al\.?)?)\s+\(((?:19|20)\d{2})[a-z]?\)/gu;
/** [1] or [1, 3] or [1-4] */
const NUMERIC_CITE = /\[(\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)\]/g;

export function analyseCitations(text) {
  const findings = [];
  const { body, referenceBlock } = splitReferences(text);
  const references = parseReferences(referenceBlock);
  const inText = collectInText(body);

  if (!inText.length && !references.length) {
    return { findings, references: [], inText: [], metrics: { referenceCount: 0, citationCount: 0 } };
  }

  const currentYear = new Date().getUTCFullYear();

  // A citation in the body with nothing matching it in the list. The most
  // common shape of a fabricated or half-remembered reference.
  const orphanCitations = inText.filter((c) => c.kind !== 'numeric' && !references.some((r) => matches(c, r)));
  if (references.length && orphanCitations.length) {
    findings.push({
      id: 'cite.orphan',
      severity: orphanCitations.length >= 3 ? 'high' : 'medium',
      title: `${orphanCitations.length} citation${orphanCitations.length === 1 ? '' : 's'} in the text with no entry in the reference list`,
      detail: 'Cited in the argument but never listed. Innocent explanation: a reference list assembled by hand and '
        + 'left incomplete. The other explanation is that the citation was invented to support a sentence.',
      quotes: orphanCitations.slice(0, 6).map((c) => `${c.author} (${c.year})`),
    });
  }

  // The reverse: padding the list with works never used.
  const uncited = references.filter((r) => !inText.some((c) => matches(c, r)));
  if (references.length >= 3 && uncited.length / references.length > 0.5) {
    findings.push({
      id: 'cite.uncited',
      severity: 'medium',
      title: `${uncited.length} of ${references.length} listed references are never cited in the text`,
      detail: 'A reference list that is not connected to the argument. This is what a list generated separately from '
        + 'the essay looks like. Innocent explanation: background reading listed as a bibliography rather than a '
        + 'reference list, which some styles permit.',
      quotes: uncited.slice(0, 5).map((r) => truncate(r.raw, 110)),
    });
  }

  const numericMax = Math.max(0, ...inText.filter((c) => c.kind === 'numeric').map((c) => c.number));
  if (numericMax > 0 && references.length && numericMax > references.length) {
    findings.push({
      id: 'cite.numeric-overflow',
      severity: 'high',
      title: `Text cites [${numericMax}] but the reference list has only ${references.length} entries`,
      detail: 'A numbered citation points past the end of the list, so it cannot resolve to anything at all.',
    });
  }

  for (const r of references) {
    if (r.year && r.year > currentYear) {
      findings.push({
        id: 'cite.future',
        severity: 'high',
        title: `Reference dated ${r.year}, which is in the future`,
        detail: 'A publication year later than today cannot be right.',
        quotes: [truncate(r.raw, 140)],
      });
    }
    if (r.doi && !/^10\.\d{4,9}\/\S+$/.test(r.doi)) {
      findings.push({
        id: 'cite.bad-doi',
        severity: 'high',
        title: `Malformed DOI: ${r.doi}`,
        detail: 'A DOI is always a registrant prefix beginning 10. followed by a slash and a suffix. This one is not '
          + 'shaped like a real identifier, which usually means it was constructed rather than copied.',
        quotes: [truncate(r.raw, 140)],
      });
    }
  }

  const withDoi = references.filter((r) => r.doi).length;
  if (references.length >= 4) {
    findings.push({
      id: 'cite.checklist',
      severity: 'info',
      title: `${references.length} references found${withDoi ? `, ${withDoi} with a DOI` : ''}`,
      detail: 'Nothing here confirms these exist. Spot-checking three or four by searching the exact title is the '
        + 'single most reliable check available to you, and it takes about two minutes. Run with --verify-citations '
        + 'to have the tool look them up against Crossref instead.',
      quotes: references.slice(0, 8).map((r) => truncate(r.raw, 120)),
    });
  }

  return {
    findings,
    references,
    inText,
    metrics: {
      referenceCount: references.length,
      citationCount: inText.length,
      orphanCount: orphanCitations.length,
      uncitedCount: uncited.length,
    },
  };
}

/** Split the body from whatever follows the References heading. */
function splitReferences(text) {
  const m = HEADINGS.exec(text);
  if (!m) {
    // Some submissions never use a heading; fall back to a run of lines that
    // look like reference entries at the end of the document.
    return { body: text, referenceBlock: '' };
  }
  return { body: text.slice(0, m.index), referenceBlock: text.slice(m.index + m[0].length) };
}

function parseReferences(block) {
  if (!block.trim()) return [];
  return block
    .split(/\n\s*\n|\n(?=[A-Z\[])/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 25 && /(?:19|20)\d{2}/.test(s))
    .slice(0, 200)
    .map((raw) => ({
      raw,
      year: Number(/(?:19|20)\d{2}/.exec(raw)?.[0]) || null,
      // The leading surname, which is what an in-text citation points at.
      author: /^\[?\d*\]?\s*([A-Z][\p{L}'’-]+)/u.exec(raw)?.[1] ?? null,
      doi: /\b(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)(\S+?)[.,;\s]*$/i.exec(raw)?.[1]
        ?? /\b(10\.\d{2,9}\/\S+?)[.,;\s]*$/.exec(raw)?.[1] ?? null,
      title: extractTitle(raw),
    }));
}

/** The title is normally the sentence after the year. Good enough to search for. */
function extractTitle(raw) {
  const afterYear = /(?:19|20)\d{2}[a-z]?\)?\.\s*([^.]{10,200})\./.exec(raw);
  return afterYear ? afterYear[1].trim() : null;
}

function collectInText(body) {
  const out = [];

  for (const group of body.matchAll(PAREN_GROUP)) {
    if (!/(?:19|20)\d{2}/.test(group[1])) continue;
    for (const chunk of group[1].split(';')) {
      const m = ONE_CITE.exec(chunk.trim().replace(CITE_PREFIX, ''));
      if (m) out.push({ kind: 'paren', author: surname(m[1]), year: Number(m[2]) });
    }
  }
  for (const m of body.matchAll(NARRATIVE_CITE)) {
    out.push({ kind: 'narrative', author: surname(m[1]), year: Number(m[2]) });
  }
  for (const m of body.matchAll(NUMERIC_CITE)) {
    for (const n of m[1].split(/[,–-]/)) {
      const num = Number(n.trim());
      if (Number.isFinite(num)) out.push({ kind: 'numeric', number: num });
    }
  }
  return out;
}

function surname(s) {
  return s.replace(/\s+et\s+al\.?$/i, '').split(/\s+(?:and|&)\s+/)[0].trim();
}

function matches(citation, reference) {
  if (citation.kind === 'numeric' || !reference.author) return false;
  const a = citation.author.toLowerCase();
  const b = reference.author.toLowerCase();
  const sameAuthor = a === b || a.startsWith(b) || b.startsWith(a);
  // Allow a year's slack: "in press" and reprint dates legitimately drift by one.
  return sameAuthor && (!citation.year || !reference.year || Math.abs(citation.year - reference.year) <= 1);
}

/**
 * Opt-in: ask Crossref whether each reference exists.
 *
 * Off by default and never automatic. Running it sends reference titles to a
 * third party, which is a decision about someone else's coursework and should
 * be made deliberately. Crossref asks callers to identify themselves, so the
 * marker's email is sent in the User-Agent as the polite pool expects.
 *
 * A miss is not proof of fabrication: Crossref does not index every book,
 * thesis, report or non-English journal. It is a prompt to look, not a verdict.
 */
export async function verifyCitations(references, { email, timeoutMs = 8000, limit = 25, apiBase = 'https://api.crossref.org' } = {}) {
  const results = [];
  const agent = `submission-check (+https://github.com/abibifogh/snpos${email ? `; mailto:${email}` : ''})`;

  for (const ref of references.slice(0, limit)) {
    const query = ref.doi
      ? `${apiBase}/works/${encodeURIComponent(ref.doi)}`
      : ref.title
        ? `${apiBase}/works?rows=3&query.bibliographic=${encodeURIComponent(ref.title)}`
        : null;

    if (!query) { results.push({ ref, status: 'unsearchable' }); continue; }

    try {
      const res = await fetch(query, { headers: { 'User-Agent': agent }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404) { results.push({ ref, status: 'not-found' }); continue; }
      if (!res.ok) { results.push({ ref, status: 'lookup-failed', note: `HTTP ${res.status}` }); continue; }

      const json = await res.json();
      const items = ref.doi ? [json.message] : (json.message?.items ?? []);
      const best = items[0];

      if (!best) { results.push({ ref, status: 'not-found' }); continue; }

      const foundTitle = Array.isArray(best.title) ? best.title[0] : best.title;
      const foundYear = best.issued?.['date-parts']?.[0]?.[0] ?? null;
      const similar = ref.title && foundTitle ? titleSimilarity(ref.title, foundTitle) : 1;

      results.push({
        ref,
        status: similar >= 0.6 ? 'found' : 'weak-match',
        foundTitle,
        foundYear,
        similarity: Number(similar.toFixed(2)),
        yearMismatch: ref.year && foundYear && Math.abs(ref.year - foundYear) > 1,
      });
    } catch (err) {
      results.push({ ref, status: 'lookup-failed', note: err.name === 'TimeoutError' ? 'timed out' : err.message });
    }
  }

  const findings = [];
  const missing = results.filter((r) => r.status === 'not-found');
  const weak = results.filter((r) => r.status === 'weak-match');
  const failed = results.filter((r) => r.status === 'lookup-failed');

  // Say so loudly when the lookup did not happen. Silence here would be read as
  // "the references checked out", and a firewall, an outage or a rate limit
  // would quietly become a clean bill of health for a fabricated bibliography.
  if (failed.length) {
    findings.push({
      id: 'cite.lookup-failed',
      severity: 'info',
      title: `${failed.length} of ${results.length} reference lookups did not complete — these were NOT checked`,
      detail: `Crossref could not be reached (${[...new Set(failed.map((f) => f.note))].join('; ')}). This says nothing `
        + 'about the references themselves: they have simply not been verified. Check network access and run again, '
        + 'or search the titles by hand.',
      quotes: failed.slice(0, 5).map((r) => truncate(r.ref.raw, 110)),
    });
  }

  if (missing.length) {
    findings.push({
      id: 'cite.not-found',
      severity: missing.length >= 3 ? 'critical' : 'high',
      title: `${missing.length} reference${missing.length === 1 ? '' : 's'} could not be found in Crossref`,
      detail: 'Searched by DOI where given, otherwise by title. Crossref does not index every book, thesis, report or '
        + 'regional journal, so a miss is a reason to check by hand rather than a conclusion. A DOI that does not '
        + 'resolve is much stronger: DOIs are registered, and an unregistered one was invented.',
      quotes: missing.slice(0, 6).map((r) => truncate(r.ref.raw, 120)),
    });
  }
  if (weak.length) {
    findings.push({
      id: 'cite.weak-match',
      severity: 'medium',
      title: `${weak.length} reference${weak.length === 1 ? '' : 's'} matched something with a noticeably different title`,
      detail: 'A real work exists at roughly this citation, but the title as written does not match it well. Often a '
        + 'transcription error; sometimes a real author and journal attached to a title that was never published in it.',
      quotes: weak.slice(0, 5).map((r) => `Cited: ${truncate(r.ref.title ?? r.ref.raw, 70)} → Found: ${truncate(r.foundTitle ?? '', 70)}`),
    });
  }
  for (const r of results.filter((x) => x.yearMismatch && x.status === 'found')) {
    findings.push({
      id: 'cite.year-mismatch',
      severity: 'medium',
      title: `Year mismatch: cited as ${r.ref.year}, published ${r.foundYear}`,
      detail: 'The work exists but not in the year given.',
      quotes: [truncate(r.ref.raw, 130)],
    });
  }

  return { results, findings };
}

/** Token overlap, enough to tell "close transcription" from "different paper". */
function titleSimilarity(a, b) {
  const set = (s) => new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) || []));
  const A = set(a);
  const B = set(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

function truncate(s, n) {
  const clean = String(s).replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}
