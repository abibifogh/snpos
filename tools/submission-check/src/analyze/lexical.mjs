/**
 * Words and phrases, and what leaks through them.
 *
 * Two very different things live in this file.
 *
 * The first is residue: text that only exists because a chat assistant wrote it
 * and nobody cleaned up afterwards. "As an AI language model", a stray "I hope
 * this helps!", markdown asterisks pasted into Word, a "[Your Name]"
 * placeholder. These are not indicators, they are the thing itself, and they
 * are scored accordingly.
 *
 * The second is vocabulary preference, which is much weaker than its reputation.
 * "Delve" is a real English word and its appearance proves nothing. What the
 * counts can show is a *rate* far outside what the same text would otherwise
 * predict. Every hit is quoted in context so the marker judges the sentence
 * rather than the word, and the list is dated in the report, because these
 * shift with every model release and a stale list quietly turns into a list of
 * ordinary academic English.
 */

/** Conversational residue. Near-conclusive: prose does not talk to its reader like this. */
const RESIDUE = [
  { re: /\bas an? (?:AI|artificial intelligence|language model)\b/gi, note: 'assistant self-reference' },
  { re: /\bI(?:'m| am) (?:an? )?(?:AI|language model|chatbot)\b/gi, note: 'assistant self-reference' },
  { re: /\b(?:my|the) (?:knowledge|training) (?:cut[- ]?off|data)\b/gi, note: 'assistant self-reference' },
  { re: /\bas of my last (?:update|knowledge)\b/gi, note: 'assistant self-reference' },
  { re: /\bI (?:don't|do not) have (?:personal|access to|the ability)\b/gi, note: 'assistant self-reference' },
  { re: /\bI (?:cannot|can't) (?:browse|access the internet|provide real[- ]time)\b/gi, note: 'assistant self-reference' },
  { re: /^\s*(?:Certainly|Sure|Of course|Absolutely)[!,]/gim, note: 'reply opener' },
  { re: /\bhere(?:'s| is) (?:a|an|the) (?:\w+ ){0,3}(?:essay|summary|report|outline|draft|response|answer|version)\b/gi, note: 'reply opener' },
  { re: /\b(?:I hope this helps|hope that helps)\b/gi, note: 'reply sign-off' },
  { re: /\b(?:let me know if|feel free to ask|would you like me to|if you(?:'d| would) like,? I can)\b/gi, note: 'reply sign-off' },
  { re: /\bwould you like me to (?:expand|elaborate|continue|adjust)\b/gi, note: 'reply sign-off' },
  { re: /\[(?:your name|insert[^\]]{0,30}|student name|date|name here|topic)\]/gi, note: 'unfilled placeholder' },
  { re: /\b(?:Note|Disclaimer): This (?:essay|response|answer|text) (?:is|was) (?:generated|written|created)\b/gi, note: 'generation disclaimer' },
];

/**
 * Markdown that a word processor would never produce.
 *
 * Chat assistants answer in markdown. Pasted into Word or exported to PDF, the
 * syntax comes through as literal characters, because Word has no idea what
 * `**` means. A student typing in Word cannot produce this by accident; they
 * would have to type the asterisks themselves and then not notice.
 */
const MARKDOWN_RESIDUE = [
  { re: /\*\*[^*\n]{2,80}\*\*/g, note: 'literal **bold** markers' },
  { re: /^#{1,6}\s+\S/gm, note: 'literal # heading markers' },
  { re: /^\s*[-*]\s{1,3}\*\*/gm, note: 'markdown bullet with bold lead-in' },
  { re: /^\s*\|[^\n]*\|\s*$/gm, note: 'markdown table pipes' },
  { re: /^\s*```/gm, note: 'code fence' },
  { re: /^---+$/gm, note: 'markdown horizontal rule' },
];

/**
 * Vocabulary that current assistants reach for more often than most writers.
 * Compiled against 2024-2026 model output; expect it to age.
 */
const FAVOURED_WORDS = [
  'delve', 'delves', 'delving', 'tapestry', 'testament', 'realm', 'landscape',
  'multifaceted', 'nuanced', 'intricate', 'myriad', 'pivotal', 'crucial',
  'paramount', 'profound', 'seamless', 'seamlessly', 'streamline', 'robust',
  'holistic', 'unwavering', 'vibrant', 'showcase', 'showcasing', 'foster',
  'fostering', 'garner', 'harness', 'harnessing', 'leverage', 'leveraging',
  'underscore', 'underscores', 'underscoring', 'navigate', 'navigating',
  'elevate', 'embark', 'illuminate', 'transformative', 'invaluable',
  'comprehensive', 'meticulous', 'meticulously', 'commendable', 'noteworthy',
];

/** Whole phrases, which carry more signal than single words. */
const FAVOURED_PHRASES = [
  { re: /\bit(?:'s| is) (?:important|worth|crucial|essential) to (?:note|remember|consider|understand)\b/gi },
  { re: /\bplays? an? (?:crucial|vital|pivotal|significant|important) role\b/gi },
  { re: /\bin (?:today's|the modern) (?:fast[- ]paced|digital|ever[- ]changing|interconnected) world\b/gi },
  { re: /\bin the (?:ever[- ]evolving|rapidly changing) (?:landscape|world|field)\b/gi },
  { re: /\bnavigat(?:e|ing) the (?:complexities|challenges|landscape)\b/gi },
  { re: /\ba testament to\b/gi },
  { re: /\bdelve into\b/gi },
  { re: /\bwhen it comes to\b/gi },
  { re: /\bnot only .{3,60}? but also\b/gi },
  { re: /\bstands? as a\b/gi },
  { re: /\bthe world of\b/gi },
  { re: /\brich tapestry\b/gi },
  { re: /\bin conclusion,/gi },
  { re: /\bby understanding .{3,60}?,? (?:we|one) can\b/gi },
  { re: /\bserves? as a (?:reminder|foundation|cornerstone|bridge)\b/gi },
];

const TRANSITIONS = /\b(?:moreover|furthermore|additionally|consequently|nevertheless|nonetheless|however|therefore|thus|hence|in addition|on the other hand|in contrast|similarly|likewise|notably|indeed|overall|ultimately|firstly|secondly|thirdly|finally|in summary|to summarise|to summarize)\b/gi;

const HEDGES = /\b(?:it (?:could|might|may) be (?:argued|said)|arguably|to some extent|in many ways|generally speaking|broadly speaking|it depends on|there is no one[- ]size[- ]fits[- ]all|striking a balance|a double[- ]edged sword)\b/gi;

export function analyseLexical(text) {
  const findings = [];
  const words = (text.toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) || []);
  const per1000 = (n) => (words.length ? (n * 1000) / words.length : 0);

  for (const { re, note } of RESIDUE) {
    const hits = [...text.matchAll(re)];
    if (!hits.length) continue;
    findings.push({
      id: 'lex.residue',
      severity: 'critical',
      title: `Conversational residue (${note}): "${truncate(hits[0][0], 80)}"`,
      detail: `${hits.length === 1 ? 'This phrase' : `${hits.length} phrases like this`} did not come from writing an `
        + 'essay; it came from an assistant replying to a request, and was left in. This is direct evidence rather '
        + 'than an indicator.',
      quotes: hits.slice(0, 3).map((h) => context(text, h.index)),
    });
  }

  const markdownHits = MARKDOWN_RESIDUE.flatMap(({ re, note }) => {
    const hits = [...text.matchAll(re)];
    return hits.length ? [{ note, count: hits.length, sample: hits[0][0] }] : [];
  });
  if (markdownHits.length >= 2 || markdownHits.some((h) => h.count >= 4)) {
    findings.push({
      id: 'lex.markdown',
      severity: 'high',
      title: `Markdown syntax left in the text (${markdownHits.map((h) => h.note).join(', ')})`,
      detail: 'Chat assistants reply in markdown. A word processor has no reason to emit these characters, and a '
        + 'student typing directly into one would have to add them deliberately. Their presence points to text pasted '
        + 'out of a chat window. Innocent explanation: the student drafted in a markdown editor such as Obsidian or Notion.',
      quotes: markdownHits.slice(0, 3).map((h) => truncate(h.sample, 90)),
    });
  }

  const favouredHits = FAVOURED_WORDS.flatMap((w) => {
    const re = new RegExp(`\\b${w}\\b`, 'gi');
    return [...text.matchAll(re)].map((m) => ({ word: w, index: m.index }));
  });
  const favouredRate = per1000(favouredHits.length);
  if (favouredRate >= 4 && favouredHits.length >= 3) {
    const tally = new Map();
    for (const h of favouredHits) tally.set(h.word, (tally.get(h.word) ?? 0) + 1);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    findings.push({
      id: 'lex.vocabulary',
      severity: favouredRate >= 8 ? 'medium' : 'low',
      title: `Elevated rate of assistant-favoured vocabulary (${favouredRate.toFixed(1)} per 1,000 words)`,
      detail: `Most-used: ${top.map(([w, n]) => `${w} ×${n}`).join(', ')}. Typical academic prose runs under 2 per `
        + '1,000. This is a preference, not a fingerprint: every one of these is a legitimate word, and a student who '
        + 'reads a lot of AI-assisted writing will pick the habit up honestly.',
      quotes: favouredHits.slice(0, 3).map((h) => context(text, h.index)),
    });
  }

  const phraseHits = FAVOURED_PHRASES.flatMap(({ re }) => [...text.matchAll(re)]);
  if (phraseHits.length >= 3) {
    findings.push({
      id: 'lex.phrases',
      severity: phraseHits.length >= 6 ? 'medium' : 'low',
      title: `${phraseHits.length} stock phrases characteristic of generated prose`,
      detail: 'Whole constructions rather than single words, which makes them somewhat stronger evidence than the '
        + 'vocabulary count. They are also exactly what essay-writing guides teach, so a student following a template '
        + 'produces them too.',
      quotes: phraseHits.slice(0, 4).map((h) => context(text, h.index)),
    });
  }

  const transitionRate = per1000((text.match(TRANSITIONS) || []).length);
  if (transitionRate >= 14) {
    findings.push({
      id: 'lex.transitions',
      severity: 'low',
      title: `Heavy use of connectives (${transitionRate.toFixed(1)} per 1,000 words)`,
      detail: 'Moreover, furthermore, consequently and their relatives appear at roughly double the usual rate for '
        + 'student essays. Generated prose signposts every join; so does writing produced to a marking rubric that '
        + 'rewards visible structure.',
    });
  }

  const hedgeRate = per1000((text.match(HEDGES) || []).length);
  if (hedgeRate >= 3) {
    findings.push({
      id: 'lex.hedging',
      severity: 'low',
      title: `Frequent non-committal balancing (${hedgeRate.toFixed(1)} per 1,000 words)`,
      detail: 'Assistants are tuned to present both sides and avoid taking a position. A student with a thesis usually '
        + 'argues for it. Weak on its own, and genuinely wrong for essays where balance is the assignment.',
    });
  }

  findings.push(...structuralFindings(text));

  return {
    findings,
    metrics: {
      favouredWordRate: Number(favouredRate.toFixed(2)),
      stockPhraseCount: phraseHits.length,
      transitionRate: Number(transitionRate.toFixed(2)),
      hedgeRate: Number(hedgeRate.toFixed(2)),
      residueCount: findings.filter((f) => f.id === 'lex.residue').length,
    },
  };
}

/** Shape rather than wording: symmetry that suggests a template being filled. */
function structuralFindings(text) {
  const out = [];
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  const openers = paragraphs
    .map((p) => p.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, ''))
    .filter(Boolean);
  const transitionOpeners = openers.filter((w) => TRANSITIONS.test(w));
  TRANSITIONS.lastIndex = 0;

  if (paragraphs.length >= 5 && transitionOpeners.length / paragraphs.length > 0.55) {
    out.push({
      id: 'lex.opener-pattern',
      severity: 'low',
      title: `${transitionOpeners.length} of ${paragraphs.length} paragraphs open with a connective`,
      detail: 'Every paragraph beginning with Moreover, Furthermore or Additionally is a template being followed '
        + 'rather than an argument being made.',
    });
  }

  // Rule of three: assistants enumerate in threes almost compulsively.
  const triples = (text.match(/\b\w+, \w+,? and \w+\b/g) || []).length;
  if (triples >= 6) {
    out.push({
      id: 'lex.rule-of-three',
      severity: 'low',
      title: `${triples} three-item lists`,
      detail: 'A strong preference for enumerating in threes. Noticeable in aggregate; meaningless in any single sentence.',
    });
  }

  const first = paragraphs[0] ?? '';
  const last = paragraphs[paragraphs.length - 1] ?? '';
  if (paragraphs.length >= 4 && overlap(first, last) > 0.42) {
    out.push({
      id: 'lex.circular',
      severity: 'low',
      title: 'Closing paragraph largely restates the opening',
      detail: `The last paragraph shares ${Math.round(overlap(first, last) * 100)}% of its content words with the `
        + 'first, adding little that is new. A conclusion that only summarises is a common shape in generated essays, '
        + 'and also in essays written to a five-paragraph formula.',
    });
  }

  return out;
}

/** Jaccard overlap on content words, used to spot a conclusion that only echoes. */
function overlap(a, b) {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'it', 'this', 'that', 'for', 'on', 'with', 'as', 'be', 'by', 'has', 'have']);
  const set = (s) => new Set((s.toLowerCase().match(/[a-z']{3,}/g) || []).filter((w) => !stop.has(w)));
  const A = set(a);
  const B = set(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

function context(text, index, span = 60) {
  if (index == null) return null;
  const start = Math.max(0, index - span);
  const raw = text.slice(start, index + span).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${raw}${index + span < text.length ? '…' : ''}`;
}

function truncate(s, n) {
  const clean = String(s).replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

export const WORDLIST_UPDATED = '2026-08';
