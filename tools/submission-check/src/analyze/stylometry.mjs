/**
 * Measurements of the prose itself.
 *
 * Read the caveat before trusting any of it. These metrics separate populations,
 * not documents. Averaged over a hundred essays they will show you something
 * real; applied to one essay they are weak, and they are weak in a biased
 * direction. Low variance, plain vocabulary and heavy connectives are what
 * machine text looks like, and they are also what careful second-language
 * writing looks like, and what a student who has been drilled in formal essay
 * structure produces. Those two groups get flagged by every statistical
 * detector on the market, and that is a known, measured, published failure.
 *
 * So the numbers are reported with their reference ranges shown, as
 * observations for a human to weigh, and they are deliberately capped in the
 * scoring so that style alone can never carry a document into the top band.
 */

/**
 * Reference bands, from published stylometric work on student and generated
 * prose. Wide on purpose: the honest ranges overlap heavily, and a narrow band
 * would imply a precision that does not exist.
 */
import { sentenceSpans } from '../spans.mjs';

const BANDS = {
  burstiness: { machine: [0.0, 0.42], mixed: [0.42, 0.55], human: [0.55, 3] },
  mattr: { machine: [0.0, 0.68], mixed: [0.68, 0.74], human: [0.74, 1] },
  hapax: { machine: [0.0, 0.38], mixed: [0.38, 0.46], human: [0.46, 1] },
};

export function analyseStyle(text) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 1);
  const sentences = splitSentences(text);
  const words = tokenise(text);

  if (words.length < 120) {
    return {
      // The word count still goes out: it is the reason the rest was skipped,
      // and the summary line looks broken without it.
      metrics: { words: words.length, sentences: sentences.length, paragraphs: paragraphs.length },
      findings: [],
      note: `Only ${words.length} words of prose; style analysis needs about 120 to say anything at all, and several `
        + 'hundred to say it with any confidence. Skipped.',
      reliable: false,
    };
  }

  const sentenceLengths = sentences.map((s) => tokenise(s).length).filter((n) => n > 0);
  const paraLengths = paragraphs.map((p) => tokenise(p).length);

  const metrics = {
    words: words.length,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    meanSentenceLength: mean(sentenceLengths),
    // Burstiness: the coefficient of variation of sentence length. Humans mix
    // a twelve-word sentence with a three-word one; sampled text regresses to
    // the mean length for the genre and stays there.
    burstiness: cv(sentenceLengths),
    paragraphBurstiness: cv(paraLengths),
    // Moving-average type-token ratio. Plain TTR falls as a document gets
    // longer, so comparing a 500-word essay to a 3000-word one on raw TTR
    // measures length, not vocabulary. A fixed window removes that.
    mattr: movingAverageTTR(words, 100),
    hapaxRatio: hapaxRatio(words),
    entropy: shannonEntropy(words),
    fleschReadingEase: flesch(words, sentenceLengths),
    ...rhythm(sentenceLengths),
    ...imperfections(text, words),
  };

  const findings = [];

  band('burstiness', metrics.burstiness, findings, {
    low: {
      title: `Sentence lengths are unusually even (burstiness ${fmt(metrics.burstiness)})`,
      detail: 'Sentence length varies little across the document. Human writing tends to alternate long and short; '
        + 'generated text clusters around a typical length. This is the most cited statistical marker and also the '
        + 'least reliable one on an individual document, because formal and second-language writing look the same way.',
    },
  });

  band('mattr', metrics.mattr, findings, {
    low: {
      title: `Narrow vocabulary for the length (MATTR ${fmt(metrics.mattr)})`,
      detail: 'Measured in 100-word windows, the same words recur more than is typical. Sampling from high-probability '
        + 'words produces this; so does writing carefully in a second language, and so does a tightly-specified topic '
        + 'where the same terms must keep being used.',
    },
  });

  if (metrics.uniformSentenceShare > 0.62 && sentenceLengths.length >= 12) {
    findings.push({
      id: 'style.uniform',
      severity: 'low',
      title: `${Math.round(metrics.uniformSentenceShare * 100)}% of sentences are within a quarter of the mean length`,
      detail: 'A strong rhythm of near-identical sentence lengths. Read a paragraph aloud: if it sounds metronomic, '
        + 'that is what this number is measuring.',
    });
  }

  if (metrics.paragraphBurstiness < 0.32 && paraLengths.length >= 6) {
    findings.push({
      id: 'style.uniform-paragraphs',
      severity: 'low',
      title: `Paragraphs are near-identical in length (variation ${fmt(metrics.paragraphBurstiness)})`,
      detail: 'Human structure is lumpy, because some points matter more to the writer than others and get more room. '
        + 'Evenly-sized paragraphs suggest structure applied rather than structure grown.',
    });
  }

  // Perfect mechanics across a long document is itself unusual. Nobody types
  // three thousand words without a double space or a stray repetition.
  if (metrics.words > 900 && metrics.imperfectionCount === 0) {
    findings.push({
      id: 'style.no-imperfections',
      severity: 'low',
      title: `No typing imperfections across ${metrics.words.toLocaleString()} words`,
      detail: 'No double spaces, repeated words, inconsistent quote marks or spacing slips anywhere. Drafts almost '
        + 'always carry a few. Innocent explanations: a thorough proofread, or a grammar checker, which most students '
        + 'now have switched on by default.',
    });
  } else if (metrics.imperfectionCount > 0) {
    findings.push({
      id: 'style.imperfections',
      severity: 'none',
      title: `${metrics.imperfectionCount} small typing imperfection${metrics.imperfectionCount === 1 ? '' : 's'} (${metrics.imperfectionKinds.join(', ')})`,
      detail: 'Counts against machine generation rather than for it. Noted so it is weighed alongside the rest.',
    });
  }

  if (metrics.punctuationVariety <= 2 && metrics.words > 700) {
    findings.push({
      id: 'style.punctuation',
      severity: 'low',
      title: 'Limited punctuation range',
      detail: `Only ${metrics.punctuationVariety} kinds of sentence punctuation in use. Writers with a personal style `
        + 'usually reach for semicolons, dashes, parentheses or questions somewhere in a long piece.',
    });
  }

  return { metrics, findings, reliable: metrics.words >= 400, note: null };
}

function band(key, value, findings, copy) {
  if (value == null || !BANDS[key]) return;
  const [, machineMax] = BANDS[key].machine;
  if (value <= machineMax) {
    findings.push({
      id: `style.${key}`,
      severity: 'low',
      title: copy.low.title,
      detail: copy.low.detail,
      reference: `Typical range: generated ≤ ${machineMax}, human ≥ ${BANDS[key].human[0]}. This document: ${fmt(value)}.`,
    });
  }
}

/**
 * Sentence text, from the same boundaries the locator uses.
 *
 * Shared rather than reimplemented, because the two must agree: if the metrics
 * counted a boundary the locator did not, a finding reported as "sentence 3"
 * would point at sentence 2 on the page. Getting the boundaries right matters
 * on its own account too, since splitting "Dr. Mensah" in two would fabricate
 * exactly the short-sentence variance burstiness is looking for.
 */
export function splitSentences(text) {
  return sentenceSpans(text)
    .map((s) => text.slice(s.start, s.end).replace(/\s+/g, ' ').trim())
    .filter((s) => tokenise(s).length > 0);
}

export function tokenise(text) {
  return (text.toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) || []);
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function cv(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  if (!m) return null;
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance) / m;
}

function movingAverageTTR(words, window) {
  if (words.length < window) {
    return new Set(words).size / words.length;
  }
  let total = 0;
  let windows = 0;
  // Step rather than slide by one: a stride of 10 gives the same answer to
  // three decimals on any realistic document and avoids O(n·window) work.
  for (let i = 0; i + window <= words.length; i += 10) {
    total += new Set(words.slice(i, i + window)).size / window;
    windows++;
  }
  return windows ? total / windows : null;
}

function hapaxRatio(words) {
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  let once = 0;
  for (const n of counts.values()) if (n === 1) once++;
  return once / counts.size;
}

/** Shannon entropy over the word distribution, in bits. */
function shannonEntropy(words) {
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / words.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function rhythm(lengths) {
  if (lengths.length < 4) return { uniformSentenceShare: 0, longestSentence: 0, shortestSentence: 0 };
  const m = mean(lengths);
  const within = lengths.filter((n) => Math.abs(n - m) <= m * 0.25).length;
  return {
    uniformSentenceShare: within / lengths.length,
    longestSentence: Math.max(...lengths),
    shortestSentence: Math.min(...lengths),
  };
}

/**
 * The small mess of real typing.
 *
 * Deliberately conservative: only things that are unambiguously slips, not
 * style choices. A false "imperfection" would push a document towards looking
 * human, which is the safer direction to be wrong in.
 */
function imperfections(text, words) {
  const kinds = [];
  let count = 0;

  const doubleSpace = (text.match(/\S {2,}\S/g) || []).length;
  if (doubleSpace) { kinds.push('double spaces'); count += doubleSpace; }

  const repeated = (text.match(/\b(\w{3,})\s+\1\b/gi) || []).length;
  if (repeated) { kinds.push('repeated words'); count += repeated; }

  const mixedQuotes = /["]/.test(text) && /[“”]/.test(text);
  if (mixedQuotes) { kinds.push('mixed quote styles'); count += 1; }

  const mixedApostrophes = /'/.test(text) && /’/.test(text);
  if (mixedApostrophes) { kinds.push('mixed apostrophes'); count += 1; }

  const spaceBeforePunct = (text.match(/\s+[,.;:!?]/g) || []).length;
  if (spaceBeforePunct) { kinds.push('spacing before punctuation'); count += spaceBeforePunct; }

  const lowercaseI = (text.match(/\bi\b(?!\.)/g) || []).length;
  if (lowercaseI) { kinds.push('uncapitalised "i"'); count += lowercaseI; }

  const punctuationVariety = [';', ':', '—', '–', '(', '?', '!'].filter((c) => text.includes(c)).length;

  return {
    imperfectionCount: count,
    imperfectionKinds: kinds,
    punctuationVariety,
    lexicalDensity: words.length ? new Set(words).size / words.length : 0,
  };
}

/** Flesch reading ease, with a syllable estimate rather than a dictionary. */
function flesch(words, sentenceLengths) {
  if (!sentenceLengths.length) return null;
  const syllables = words.reduce((a, w) => a + countSyllables(w), 0);
  const wordsPerSentence = words.length / sentenceLengths.length;
  return 206.835 - 1.015 * wordsPerSentence - 84.6 * (syllables / words.length);
}

function countSyllables(word) {
  const w = word.replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const groups = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
}

function fmt(n) {
  return n == null ? '—' : n.toFixed(2);
}
