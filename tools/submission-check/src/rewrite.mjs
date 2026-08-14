/**
 * Plainer alternatives for the phrases the tool flags.
 *
 * These exist to be handed to the student. "Your writing pattern-matches to
 * generated text" is not teachable feedback; "paragraph 3 says *plays a
 * crucial role in* where it could say *shapes*" is. Most of what gets flagged
 * as an AI tell is really just padding, and padding is a thing you can show
 * someone how to cut, whoever or whatever produced it.
 *
 * That is worth being clear about, because the same table read backwards would
 * be a guide to evading detection. It is written the way a marker would use
 * it: each entry says what the phrase does to a sentence, so the note that
 * reaches the student is about their writing rather than about a detector.
 *
 * The rewrites are mechanical substitutions, not edits. They are a starting
 * point for a comment, and sometimes the honest suggestion is "cut this".
 */

/**
 * action: 'replace' swaps the match, 'delete' removes it, 'delete-sentence'
 * drops the lot, and 'advise' explains without offering a mechanical rewrite.
 *
 * 'advise' exists because some of these cannot be fixed by substitution. "By
 * understanding X, we can Y" needs the sentence rethinking, and a tool that
 * produced a broken rewrite for it would teach the reader to distrust the ones
 * that are right.
 *
 * `alternativesFor(matched)` is used where the replacement has to agree with
 * what it replaced, so that "delving into" does not become "examines".
 */
export const PHRASE_REWRITES = [
  // Conversational residue: none of this belongs in submitted work at all.
  {
    re: /\bas an? (?:AI|artificial intelligence|language model)[^.!?]*[.!?]/gi,
    action: 'delete-sentence',
    why: 'An assistant talking about itself. Nothing in the sentence is about the topic.',
  },
  {
    re: /^\s*(?:Certainly|Sure|Of course|Absolutely)[!,]\s*/gim,
    action: 'delete',
    why: 'A reply opener. An essay does not answer anyone.',
  },
  {
    re: /\bhere(?:'s| is) (?:a|an|the) (?:\w+[- ]){0,3}(?:essay|summary|report|outline|draft|response|answer|version)\b[^.!?]*[.!?]/gi,
    action: 'delete-sentence',
    why: 'Announces the document instead of starting it. Open with the argument.',
  },
  {
    re: /\b(?:I hope this helps|hope that helps)[!.]?/gi,
    action: 'delete',
    why: 'A sign-off to a reader who is not there.',
  },
  {
    re: /\b(?:let me know if|feel free to ask|would you like me to)[^.!?]*[.!?]/gi,
    action: 'delete-sentence',
    why: 'Offers further help, which is not something a submission can do.',
  },
  {
    re: /\[(?:your name|insert[^\]]{0,30}|student name|name here|topic)\]/gi,
    action: 'replace',
    alternatives: ['(fill this in)'],
    why: 'A placeholder that was never filled in.',
  },

  // Padding: says that a point matters rather than making it.
  {
    // "that" optional: the detector matches the phrase without it too, and a
    // rewrite that only fires on the longer form leaves half the hits bare.
    re: /\bit(?:'s| is) (?:important|worth|crucial|essential) to (?:note|remember|consider|understand)(?: that)?\b,?\s*/gi,
    action: 'delete',
    why: 'Announces the point instead of making it. The sentence after it is the sentence.',
  },
  {
    re: /\bin (?:today's|the modern) (?:fast[- ]paced|digital|ever[- ]changing|interconnected) world,?\s*/gi,
    action: 'delete',
    why: 'An opener that could precede any essay on any subject.',
  },
  {
    re: /\bin the (?:ever[- ]evolving|rapidly changing|complex) (?:landscape|world|field) of\b/gi,
    action: 'replace',
    alternatives: ['in'],
    why: 'Six words doing the work of one.',
  },
  { re: /\bin conclusion,\s*/gi, action: 'delete', why: 'The reader can see it is the last paragraph.' },
  { re: /\bthe world of\b\s*/gi, action: 'delete', why: '"The world of politics" is just "politics".' },
  { re: /\brich tapestry of\b/gi, action: 'replace', alternatives: ['range of', 'mix of'], why: 'A stock metaphor.' },

  // Verbose constructions with plain equivalents.
  {
    re: /\b(plays?) an? (?:crucial|vital|pivotal|significant|important|key) role(\s+in)?\b/gi,
    action: 'replace',
    // Without the "in" there is no object to attach a transitive verb to, so
    // "shapes" would leave the sentence dangling and "matters" is the honest swap.
    alternativesFor: (m) => (/\sin$/i.test(m)
      ? (/^plays\b/i.test(m) ? ['shapes', 'drives'] : ['shape', 'drive'])
      : (/^plays\b/i.test(m) ? ['matters'] : ['matter'])),
    why: 'Five words for one verb.',
  },
  {
    re: /\bnavigat(e|es|ing) the (?:complexities|challenges|landscape) of\b/gi,
    action: 'replace',
    alternativesFor: (m) => (/^navigating/i.test(m)
      ? ['working through', 'dealing with']
      : /^navigates/i.test(m) ? ['works through', 'deals with'] : ['work through', 'deal with']),
    why: 'A stock metaphor that adds nothing to the noun it introduces.',
  },
  { re: /\bis a testament to\b/gi, action: 'replace', alternatives: ['shows', 'proves'], why: 'Plainer as a verb.' },
  { re: /\ba testament to\b/gi, action: 'replace', alternatives: ['evidence of'], why: 'Plainer as a noun.' },
  {
    re: /\bdelv(e|es|ing) into\b/gi,
    action: 'replace',
    alternativesFor: (m) => (/^delving/i.test(m)
      ? ['examining', 'going into']
      : /^delves/i.test(m) ? ['examines', 'goes into'] : ['examine', 'go into']),
    why: 'Nearly always means "examine".',
  },
  { re: /\bwhen it comes to\b/gi, action: 'replace', alternatives: ['for', 'in'], why: 'Four words that can usually be one.' },
  { re: /\bstands? as a\b/gi, action: 'replace', alternatives: ['is a'], why: 'The verb is doing nothing.' },
  { re: /\bserves? as a reminder that\b/gi, action: 'replace', alternatives: ['reminds us that'], why: 'Plainer as a verb.' },
  {
    re: /\bby understanding\b[^.!?]*\bwe can\b/gi,
    action: 'advise',
    why: 'A closing formula: "by understanding X, we can Y" rarely says anything the essay has not already '
      + 'established. Cut it and state Y directly, or end on the argument rather than on a promise.',
  },
  { re: /\bit is essential to\b/gi, action: 'replace', alternatives: ['we must', 'the task is to'], why: 'Vague obligation.' },
  { re: /\bplethora of\b/gi, action: 'replace', alternatives: ['many', 'a lot of'], why: 'Ornament.' },
  { re: /\bin order to\b/gi, action: 'replace', alternatives: ['to'], why: 'Two words that are never needed.' },
  { re: /\bdue to the fact that\b/gi, action: 'replace', alternatives: ['because'], why: 'Five words for one.' },

  // Connectives, where the plainer word is almost always right.
  { re: /\b(?:Moreover|Furthermore|Additionally),\s*/gi, action: 'delete', why: 'The next sentence follows anyway; if it does not, the join needs an argument, not a label.' },
  { re: /\bConsequently,\s*/gi, action: 'replace', alternatives: ['So, '], why: 'Plainer.' },
  { re: /\bNevertheless,\s*/gi, action: 'replace', alternatives: ['Still, '], why: 'Plainer.' },
  { re: /\bUltimately,\s*/gi, action: 'delete', why: 'Rarely changes the sentence.' },
];

/**
 * Single words that current models over-reach for, and the plainer word
 * underneath. Nothing here is wrong; the point is that it is usually reaching.
 */
export const WORD_REWRITES = {
  delve: ['examine', 'explore'],
  delves: ['examines', 'explores'],
  delving: ['examining', 'exploring'],
  tapestry: ['range', 'mix'],
  testament: ['evidence', 'proof'],
  realm: ['area', 'field'],
  landscape: ['field', 'situation'],
  multifaceted: ['complex', 'many-sided'],
  nuanced: ['subtle'],
  intricate: ['complex', 'detailed'],
  myriad: ['many'],
  pivotal: ['key', 'central'],
  crucial: ['important', 'key'],
  paramount: ['most important'],
  profound: ['deep', 'far-reaching'],
  seamless: ['smooth'],
  seamlessly: ['smoothly'],
  streamline: ['simplify'],
  robust: ['strong', 'reliable'],
  holistic: ['overall'],
  unwavering: ['steady', 'constant'],
  vibrant: ['lively'],
  showcase: ['show', 'display'],
  showcasing: ['showing', 'displaying'],
  foster: ['encourage', 'support'],
  fostering: ['encouraging', 'supporting'],
  garner: ['gather', 'attract'],
  harness: ['use', 'draw on'],
  harnessing: ['using', 'drawing on'],
  leverage: ['use'],
  leveraging: ['using'],
  underscore: ['highlight', 'stress'],
  underscores: ['highlights', 'stresses'],
  underscoring: ['highlighting', 'stressing'],
  navigate: ['handle', 'deal with'],
  navigating: ['handling', 'dealing with'],
  elevate: ['raise', 'improve'],
  embark: ['begin', 'start'],
  illuminate: ['clarify', 'show'],
  transformative: ['far-reaching'],
  invaluable: ['very useful'],
  comprehensive: ['thorough', 'full'],
  meticulous: ['careful'],
  meticulously: ['carefully'],
  commendable: ['good', 'praiseworthy'],
  noteworthy: ['notable'],
};

/** Suggestion for a single flagged word, or null when we have nothing better. */
export function suggestForWord(word) {
  const alternatives = WORD_REWRITES[word.toLowerCase()];
  if (!alternatives) return null;
  return {
    action: 'replace',
    alternatives,
    why: 'A plainer word carries the same meaning, and reaching for the formal one is the habit being flagged.',
  };
}

/**
 * The rewrite for a matched string, and *which part of it* to swap.
 *
 * The sub-span matters. A detector may flag "by understanding these factors we
 * can foster change" while the rewrite only concerns "by understanding";
 * substituting across the whole detection span would produce a sentence that
 * says nothing. So the offsets of the rewrite's own match come back with it,
 * relative to the string passed in, and only that range is ever replaced.
 */
export function matchRewrite(matched) {
  for (const entry of PHRASE_REWRITES) {
    // A fresh non-global copy: testing the table's own /g regexes would
    // advance lastIndex and make the next caller miss.
    const re = new RegExp(entry.re.source, entry.re.flags.replace(/[gy]/g, ''));
    const m = re.exec(matched);
    if (!m) continue;
    return {
      action: entry.action,
      alternatives: entry.alternativesFor ? entry.alternativesFor(m[0]) : (entry.alternatives ?? []),
      why: entry.why,
      start: m.index,
      end: m.index + m[0].length,
    };
  }

  const word = suggestForWord(matched.trim());
  if (!word) return null;
  const lead = matched.length - matched.trimStart().length;
  return { ...word, start: lead, end: lead + matched.trim().length };
}

/**
 * Apply replacements to a sentence and tidy up after them.
 *
 * Deleting a phrase leaves debris, a doubled space, a stranded comma, a
 * lowercase first word. A suggestion that arrives with those in it looks
 * careless and gets ignored, so the cleanup is part of the job.
 *
 * Replacements are offsets relative to `sentence`, applied right to left so
 * that earlier offsets stay valid as the string changes underneath them.
 */
export function rewriteSentence(sentence, replacements) {
  let out = sentence;

  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    const original = out.slice(r.start, r.end);
    const replacement = r.action === 'delete' ? '' : matchCase(r.replacement ?? '', original);
    out = out.slice(0, r.start) + replacement + out.slice(r.end);
    if (replacement) out = fixArticleBefore(out, r.start);
  }

  return tidy(out);
}

/** Mirror the original's capitalisation so a swap does not start a sentence lowercase. */
function matchCase(replacement, original) {
  if (!replacement || !original) return replacement;
  if (/^\p{Lu}/u.test(original) && !/^\p{Lu}/u.test(replacement)) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** Words beginning with a vowel letter that take "a", and consonants that take "an". */
const SOUNDS_CONSONANT = /^(?:u(?:ni|se|sua|tili|ni|nan)|eu|one)/i;
const SOUNDS_VOWEL = /^(?:hour|honest|honou?r|heir)/i;

/**
 * Fix the article immediately before a replacement.
 *
 * Swapping "crucial" for "important" turns "a crucial role" into "a important
 * role", and a suggestion with a grammar error in it will not be passed on.
 * Scoped to the one article touching the edit, so no other "a" in the sentence
 * is at risk.
 */
function fixArticleBefore(text, offset) {
  const before = text.slice(0, offset);
  const m = /\b(a|an|A|An)(\s+)$/.exec(before);
  if (!m) return text;

  const following = text.slice(offset).trimStart();
  const startsVowel = /^[aeiou]/i.test(following);
  const wantsAn = (startsVowel && !SOUNDS_CONSONANT.test(following)) || SOUNDS_VOWEL.test(following);
  const correct = wantsAn ? 'an' : 'a';
  if (m[1].toLowerCase() === correct) return text;

  const cased = /^\p{Lu}/u.test(m[1]) ? correct[0].toUpperCase() + correct.slice(1) : correct;
  return before.slice(0, m.index) + cased + m[2] + text.slice(offset);
}

function tidy(s) {
  return s
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,;:]+/, '')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/^(\p{Ll})/u, (c) => c.toUpperCase())
    .trim();
}
