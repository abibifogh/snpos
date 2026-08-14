/**
 * Characters that are in the file but not on the page.
 *
 * This is the part of the tool that finds things rather than infers them. Every
 * finding here is a fact about the bytes: either a zero-width character is
 * present or it is not. That makes these the only signals strong enough to
 * raise on their own, and they are worth separating sharply from the
 * statistical guesswork further down.
 *
 * Three things end up here, and they are not the same thing:
 *
 *   1. Steganographic watermarks. Some AI text services, and a lot of
 *      "humanise your AI text" middlemen, tag output with invisible codepoints.
 *      Where the scheme is a known one the payload is decoded and printed.
 *   2. Detector evasion. Homoglyph substitution and zero-width injection are
 *      the standard tricks for defeating similarity checkers, and they are
 *      deliberate in a way that a stylistic tell never is.
 *   3. Prompt injection aimed at the marker. Hidden white or 1pt text telling
 *      an automated grader to award full marks is now common enough to test
 *      for by default.
 *
 * None of this detects cryptographic watermarking (SynthID, or green-list
 * token biasing). Those live in the choice of words, not in extra characters,
 * and cannot be read without the provider's key. The report says so rather
 * than letting silence imply a clean bill of health.
 */

const ZERO_WIDTH = {
  0x200b: 'ZERO WIDTH SPACE',
  0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER',
  0x2060: 'WORD JOINER',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE (BOM)',
  0x180e: 'MONGOLIAN VOWEL SEPARATOR',
  0x00ad: 'SOFT HYPHEN',
};

const BIDI = {
  0x202a: 'LEFT-TO-RIGHT EMBEDDING', 0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING', 0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE', 0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE', 0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
};

const ODD_SPACES = {
  0x00a0: 'NO-BREAK SPACE', 0x2000: 'EN QUAD', 0x2001: 'EM QUAD',
  0x2002: 'EN SPACE', 0x2003: 'EM SPACE', 0x2004: 'THREE-PER-EM SPACE',
  0x2005: 'FOUR-PER-EM SPACE', 0x2006: 'SIX-PER-EM SPACE',
  0x2007: 'FIGURE SPACE', 0x2008: 'PUNCTUATION SPACE', 0x2009: 'THIN SPACE',
  0x200a: 'HAIR SPACE', 0x202f: 'NARROW NO-BREAK SPACE',
  0x205f: 'MEDIUM MATHEMATICAL SPACE', 0x3000: 'IDEOGRAPHIC SPACE',
};

/** Latin letters these are visually indistinguishable from, by codepoint. */
const HOMOGLYPHS = new Map(Object.entries({
  // Cyrillic
  а: 'a', в: 'b', с: 'c', е: 'e', н: 'h', к: 'k', м: 'm', о: 'o', р: 'p',
  ѕ: 's', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ԁ: 'd', ѵ: 'v',
  А: 'A', В: 'B', С: 'C', Е: 'E', Н: 'H', І: 'I', Ј: 'J', К: 'K', М: 'M',
  О: 'O', Р: 'P', Ѕ: 'S', Т: 'T', У: 'Y', Х: 'X',
  // Greek
  ο: 'o', Ο: 'O', Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K',
  Μ: 'M', Ν: 'N', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X', ν: 'v', ρ: 'p',
}));

export function analyseHidden(text, meta = {}) {
  const findings = [];
  const counts = new Map();
  const positions = new Map();

  for (const { cp, index } of codepoints(text)) {
    let label = null;
    if (ZERO_WIDTH[cp]) label = `zero-width:${ZERO_WIDTH[cp]}`;
    else if (BIDI[cp]) label = `bidi:${BIDI[cp]}`;
    else if (ODD_SPACES[cp] && cp !== 0x00a0) label = `space:${ODD_SPACES[cp]}`;
    else if (cp === 0x00a0) label = 'space:NO-BREAK SPACE';
    else if (cp >= 0xe0000 && cp <= 0xe007f) label = 'tag:UNICODE TAG CHARACTER';
    else if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) label = 'vs:VARIATION SELECTOR';
    if (!label) continue;

    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (!positions.has(label)) positions.set(label, index);
  }

  // Non-breaking spaces arrive legitimately from Word's own autoformatting, so
  // a handful is noise. A run of them, or one per line, is a signature.
  for (const [label, count] of counts) {
    const [group, name] = label.split(':');
    const benign = group === 'space' && count <= 3;
    if (benign) continue;

    findings.push({
      id: `hidden.${group}`,
      severity: group === 'tag' || group === 'zero-width' || group === 'bidi' ? 'high' : 'medium',
      title: `${count}× ${name}`,
      detail: describe(group, count),
      context: snippet(text, positions.get(label)),
      count,
    });
  }

  const payloads = [
    decodeTagChars(text),
    decodeVariationSelectors(text),
    decodeZeroWidthBinary(text),
  ].filter(Boolean);

  for (const p of payloads) {
    findings.push({
      id: 'hidden.payload',
      severity: 'critical',
      title: `Decoded hidden message (${p.scheme})`,
      detail: `A readable payload was recovered from invisible characters: "${p.text}". Invisible characters do not `
        + 'occur by accident in a decodable pattern. This was inserted deliberately, by a tool or by a person.',
      count: 1,
    });
  }

  for (const h of homoglyphWords(text)) {
    findings.push({
      id: 'hidden.homoglyph',
      severity: 'high',
      title: `Mixed-script word: "${h.word}"`,
      detail: `Contains ${h.script} characters shaped like Latin letters (${h.detail}). This is the standard way to `
        + 'defeat a text-matching checker while leaving the page looking normal.',
      count: h.count,
    });
  }

  // Concealed formatting comes from the extractor, which can see the styling
  // that plain text has already thrown away.
  for (const run of meta.concealedRuns ?? []) {
    findings.push({
      id: 'hidden.concealed-text',
      severity: 'critical',
      title: `Text concealed by formatting (${run.reason})`,
      detail: `The document contains text that is present but not visible when read normally: "${truncate(run.text, 300)}"`
        + (looksLikeInjection(run.text)
          ? ' — and it reads as an instruction aimed at an automated marker, which makes it deliberate.'
          : ''),
      count: 1,
    });
  }

  return { findings, counts: Object.fromEntries(counts) };
}

function describe(group, count) {
  switch (group) {
    case 'tag':
      return 'Unicode tag characters have no legitimate use in prose. They are invisible everywhere and exist almost '
        + 'solely to carry hidden data inside ordinary-looking text.';
    case 'zero-width':
      return 'Zero-width characters occupy no space on the page. A few can come from copying out of a web page; '
        + `${count} of them is a pattern, and they are the most common carrier for a text watermark.`;
    case 'bidi':
      return 'Bidirectional overrides can reorder or conceal text so that what is displayed differs from what is '
        + 'stored. Legitimate in Arabic and Hebrew text, hard to explain otherwise.';
    case 'vs':
      return 'Variation selectors normally follow an emoji to pick a style. Standing alone or in long runs they are '
        + 'a known steganographic carrier, one byte per selector.';
    default:
      return 'Unusual whitespace characters. Often just a paste from a web page, but they also survive copying in a '
        + 'way that makes them a convenient marker.';
  }
}

function* codepoints(text) {
  let i = 0;
  for (const ch of text) {
    yield { cp: ch.codePointAt(0), index: i };
    i += ch.length;
  }
}

/** The Unicode Tags block maps one-to-one onto ASCII; subtract the block base. */
function decodeTagChars(text) {
  const chars = [...text].filter((c) => {
    const cp = c.codePointAt(0);
    return cp >= 0xe0000 && cp <= 0xe007f;
  });
  if (chars.length < 4) return null;
  const decoded = chars.map((c) => String.fromCharCode(c.codePointAt(0) - 0xe0000)).join('');
  return printable(decoded) ? { scheme: 'Unicode tag characters', text: truncate(decoded, 400) } : null;
}

/**
 * The variation-selector byte scheme: VS1..VS16 carry 0x00-0x0F, and the
 * supplementary block carries 0x10-0xFF. Widely circulated as a way to hide
 * arbitrary data in a single visible character.
 */
function decodeVariationSelectors(text) {
  const bytes = [];
  for (const c of text) {
    const cp = c.codePointAt(0);
    if (cp >= 0xfe00 && cp <= 0xfe0f) bytes.push(cp - 0xfe00);
    else if (cp >= 0xe0100 && cp <= 0xe01ef) bytes.push(cp - 0xe0100 + 16);
  }
  if (bytes.length < 4) return null;
  const decoded = Buffer.from(bytes).toString('utf8');
  return printable(decoded) ? { scheme: 'variation selectors', text: truncate(decoded, 400) } : null;
}

/** Zero-width binary: the usual convention is ZWSP=0, ZWNJ=1, eight to a byte. */
function decodeZeroWidthBinary(text) {
  const bits = [...text]
    .map((c) => (c === '​' ? '0' : c === '‌' ? '1' : null))
    .filter(Boolean)
    .join('');
  if (bits.length < 24) return null;
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const decoded = Buffer.from(bytes).toString('utf8');
  return printable(decoded) ? { scheme: 'zero-width binary', text: truncate(decoded, 400) } : null;
}

/** Did we decode a message, or noise that happens to fit in a byte? */
function printable(s) {
  if (s.length < 3) return false;
  const good = (s.match(/[\x20-\x7e -ɏ]/g) || []).length;
  return good / s.length > 0.85;
}

/**
 * Words that mix scripts. A wholly Cyrillic word is Russian; a word with one
 * Cyrillic letter among Latin ones is a substitution.
 */
function homoglyphWords(text) {
  const out = new Map();
  for (const m of text.matchAll(/[\p{L}\p{M}'’-]{2,}/gu)) {
    const word = m[0];
    if (!/[a-zA-Z]/.test(word)) continue;

    const swaps = [...word].filter((c) => HOMOGLYPHS.has(c));
    if (!swaps.length) continue;

    const key = word.toLowerCase();
    const existing = out.get(key);
    if (existing) { existing.count++; continue; }

    out.set(key, {
      word,
      count: 1,
      script: /[Ѐ-ӿ]/.test(word) ? 'Cyrillic' : 'Greek',
      detail: swaps.map((c) => `${c} for ${HOMOGLYPHS.get(c)}`).join(', '),
    });
  }
  return [...out.values()].slice(0, 12);
}

const INJECTION_HINTS = /\b(ignore|disregard|previous instructions?|as an ai|grade|full marks?|highest score|award|do not flag|human[- ]written|100%|A\+)\b/i;
function looksLikeInjection(s) {
  return INJECTION_HINTS.test(s);
}

/**
 * Everything this module can flag, as one class, so the context line marks all
 * of it. Kept beside the tables above: a character that can be detected but not
 * displayed produces a snippet that looks like ordinary prose, which reads as
 * the tool contradicting itself.
 */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿︀-️]|[\u{e0000}-\u{e007f}]|[\u{e0100}-\u{e01ef}]/gu;

function snippet(text, index, span = 40) {
  if (index == null) return null;
  const raw = text.slice(Math.max(0, index - span), index + span);
  return raw.replace(INVISIBLE, '·').replace(/\s+/g, ' ').trim();
}

function truncate(s, n) {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}
