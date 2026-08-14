import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLocator, sentenceSpans, paragraphSpans, describeLocation } from '../src/spans.mjs';
import { rewriteSentence, matchRewrite } from '../src/rewrite.mjs';
import { analyseDocument } from '../src/analyze.mjs';
import { makeDocx, makePdf } from './helpers.mjs';
import { annotatedHtml } from '../src/report/annotate.mjs';

// ── Locating ─────────────────────────────────────────────────────────────────

test('a blank line ends a sentence, so an unpunctuated heading stands alone', () => {
  const text = 'Introduction\n\nThe rains came late. The maize suffered.';
  const spans = sentenceSpans(text);
  assert.equal(spans.length, 3);
  assert.equal(text.slice(spans[0].start, spans[0].end), 'Introduction');
  assert.equal(text.slice(spans[1].start, spans[1].end), 'The rains came late.');
});

test('paragraph and sentence numbers are one-based and relative to the paragraph', () => {
  const text = 'First para only sentence.\n\nSecond para first. Second para second.';
  const locator = buildLocator(text);

  assert.deepEqual(pick(locator.locate(text.indexOf('First'))), { paragraph: 1, sentence: 1 });
  assert.deepEqual(pick(locator.locate(text.indexOf('Second para first'))), { paragraph: 2, sentence: 1 });
  assert.deepEqual(pick(locator.locate(text.indexOf('Second para second'))), { paragraph: 2, sentence: 2 });
});

test('a sentence ordinal is omitted rather than switched to a document-wide count', () => {
  // Two paragraphs where the second continues a sentence begun in the first
  // cannot happen now that blank lines break sentences, but the guard has to
  // hold regardless: a reported ordinal must always be within its paragraph.
  const text = 'One. Two. Three.\n\nFour. Five.';
  const locator = buildLocator(text);
  for (const offset of [0, 5, 10, 17, 23]) {
    const loc = locator.locate(offset);
    const within = loc.sentence;
    assert.ok(within === null || (within >= 1 && within <= 3), `sentence ${within} out of range for paragraph ${loc.paragraph}`);
  }
});

test('paragraph spans skip blank runs and keep offsets true', () => {
  const text = 'Alpha.\n\n\n   \n\nBeta.';
  const spans = paragraphSpans(text);
  assert.equal(spans.length, 2);
  assert.equal(text.slice(spans[1].start, spans[1].end), 'Beta.');
});

test('PDF findings carry a page number', async () => {
  const doc = await analyseDocument(makePdf([
    'Page one text about the topic at hand and nothing else.',
  ]), 'r.pdf');
  // One content stream, so everything lands on page 1.
  const locator = buildLocator(doc.text, { pageBreaks: [0] });
  assert.equal(locator.locate(5).page, 1);
  assert.match(describeLocation(locator.locate(5)), /^page 1/);
});

// ── Rewriting ────────────────────────────────────────────────────────────────

test('a deletion tidies up the debris it leaves behind', () => {
  const out = rewriteSentence('In today\'s fast-paced world, the policy failed.', [
    { start: 0, end: 27, action: 'delete' },
  ]);
  assert.equal(out, 'The policy failed.');
});

test('the article before a replacement is corrected', () => {
  const sentence = 'It plays a crucial part.';
  const start = sentence.indexOf('crucial');
  const out = rewriteSentence(sentence, [
    { start, end: start + 'crucial'.length, action: 'replace', replacement: 'important' },
  ]);
  assert.equal(out, 'It plays an important part.');
});

test('an article is not broken in the other direction', () => {
  const sentence = 'It was an intricate design.';
  const start = sentence.indexOf('intricate');
  const out = rewriteSentence(sentence, [
    { start, end: start + 'intricate'.length, action: 'replace', replacement: 'complex' },
  ]);
  assert.equal(out, 'It was a complex design.');
});

test('replacements keep the capitalisation of what they replace', () => {
  const out = rewriteSentence('Crucial reforms followed.', [
    { start: 0, end: 7, action: 'replace', replacement: 'important' },
  ]);
  assert.equal(out, 'Important reforms followed.');
});

test('verb rewrites agree with the form they replace', () => {
  assert.equal(matchRewrite('delving into').alternatives[0], 'examining');
  assert.equal(matchRewrite('delves into').alternatives[0], 'examines');
  assert.equal(matchRewrite('delve into').alternatives[0], 'examine');
  assert.equal(matchRewrite('Navigating the complexities of').alternatives[0], 'working through');
});

test('a rewrite narrower than the detection span replaces only its own part', () => {
  const r = matchRewrite('plays a crucial role in');
  assert.equal(r.alternatives[0], 'shapes');
  assert.equal(r.start, 0);
  assert.equal(r.end, 'plays a crucial role in'.length);
});

test('phrases that cannot be fixed by substitution advise instead of mangling', () => {
  const r = matchRewrite('by understanding these factors we can');
  assert.equal(r.action, 'advise');
  assert.deepEqual(r.alternatives, []);
});

// ── End to end ───────────────────────────────────────────────────────────────

test('flagged strings carry a location and a grammatical rewrite', async () => {
  const doc = await analyseDocument(makeDocx([
    'Introduction',
    'In today\'s fast-paced world, it is important to note that this is a multifaceted issue.',
    'Infrastructure plays a crucial role in output. We must delve into the rich tapestry of causes.',
  ]), 'essay.docx');

  const byText = Object.fromEntries(doc.annotations.map((a) => [a.text, a]));

  assert.equal(byText["In today's fast-paced world"].where, 'paragraph 2, sentence 1');
  assert.equal(byText["In today's fast-paced world"].after, 'It is important to note that this is a multifaceted issue.');

  assert.equal(byText['plays a crucial role in'].where, 'paragraph 3, sentence 1');
  assert.equal(byText['plays a crucial role in'].after, 'Infrastructure shapes output.');

  assert.equal(byText['delve into'].after, 'We must examine the rich tapestry of causes.');
});

/**
 * The vocabulary and stock-phrase checks only fire above a rate, so a fixture
 * for them has to carry several of each. One flagged word in a short paragraph
 * is deliberately below the threshold.
 */
const PADDED = [
  'It is important to note that the ministry plays a crucial role in rural programmes.',
  'The reform is a testament to a multifaceted and pivotal shift in policy.',
];

test('overlapping flags are reduced to the most specific one', async () => {
  const doc = await analyseDocument(makeDocx(PADDED), 'essay.docx');
  const texts = doc.annotations.map((a) => a.text);

  assert.ok(texts.includes('plays a crucial role in'), `expected the phrase, got ${JSON.stringify(texts)}`);
  assert.ok(!texts.includes('crucial'), '"crucial" is inside the phrase and must not be listed separately');
  assert.ok(texts.includes('multifaceted'), 'a favoured word outside any phrase is still listed');
});

test('invisible characters are described rather than printed into the markup', async () => {
  const payload = [...'wm1'].map((c) => String.fromCodePoint(c.charCodeAt(0) + 0xe0000)).join('');
  const doc = await analyseDocument(makeDocx([`The argument holds.${payload} It continues here.`]), 'essay.docx');

  const html = annotatedHtml(doc.text, doc.annotations);
  assert.match(html, /invisible characters?</);
  assert.ok(![...html].some((ch) => ch.codePointAt(0) >= 0xe0000), 'raw tag characters must not reach the page');

  // Deleting them changes nothing on the page, so no before/after pair is
  // offered; two identical lines would read as a broken report.
  const hidden = doc.annotations.find((a) => a.findingId.startsWith('hidden.'));
  assert.equal(hidden.noVisibleChange, true);
  assert.equal(hidden.after, null);
});

test('the annotated view numbers paragraphs to match the quoted locations', async () => {
  const doc = await analyseDocument(makeDocx([
    'Opening paragraph without anything notable in it at all.',
    ...PADDED,
  ]), 'essay.docx');

  const html = annotatedHtml(doc.text, doc.annotations);
  assert.match(html, /<span class="pnum"[^>]*>1<\/span>/);
  assert.match(html, /<span class="pnum"[^>]*>3<\/span>/);
  assert.match(html, /<mark class="hl[^"]*"[^>]*>plays a crucial role in/);

  // The paragraph a highlight lands in must be the one the finding names.
  const flagged = doc.annotations.find((a) => a.text === 'plays a crucial role in');
  assert.equal(flagged.location.paragraph, 2);
});

function pick(loc) {
  return { paragraph: loc.paragraph, sentence: loc.sentence };
}
