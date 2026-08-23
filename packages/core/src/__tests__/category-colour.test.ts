import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_COLOURS, normaliseColour, colourProblem, luminance, inkOn,
  chipColour, showsPicture, colourName,
} from '../category-colour.ts';

test('a colour is tidied so one value has one shape', () => {
  // It is written once and read back into a swatch, a picker and a chip. Two
  // spellings of the same colour means the swatch stops looking chosen.
  assert.equal(normaliseColour('#0F766E'), '#0f766e');
  assert.equal(normaliseColour('0f766e'), '#0f766e');
  assert.equal(normaliseColour('  #0f766e  '), '#0f766e');
  assert.equal(normaliseColour(''), '');
  assert.equal(normaliseColour(undefined), '');
});

test('shorthand and names are refused rather than guessed at', () => {
  // '#abc' and 'red' both have obvious intentions and no single answer worth
  // storing. Refusing is cheaper than a value the picker cannot show.
  assert.equal(normaliseColour('#abc'), '');
  assert.equal(normaliseColour('red'), '');
  assert.match(colourProblem('#abc') ?? '', /six-digit code/);
  assert.match(colourProblem('nonsense') ?? '', /not a colour/);
});

test('no colour is the default, not an error', () => {
  assert.equal(colourProblem(''), null);
  assert.equal(colourProblem(undefined), null);
  assert.equal(colourProblem('#0f766e'), null);
});

test('the text colour is worked out, never assumed to be white', () => {
  /**
   * A palette is easy to keep dark; a typed colour is not. A business that
   * types its own brand yellow would otherwise get white text on it and a
   * category nobody can read — the one thing this must never do is make the
   * till worse than the plain chip it replaced.
   */
  assert.equal(inkOn('#0f766e'), '#ffffff', 'dark teal takes white');
  assert.equal(inkOn('#ffe066'), '#16202b', 'a bright yellow takes black');
  assert.equal(inkOn('#ffffff'), '#16202b');
  assert.equal(inkOn('#000000'), '#ffffff');
});

test('every offered swatch can actually carry its text', () => {
  // The point of a short list is that none of them can be a bad choice. If a
  // swatch is ever added that fails this, the list is wrong, not the test.
  for (const c of CATEGORY_COLOURS) {
    const ink = inkOn(c.hex);
    const [lo, hi] = [luminance(c.hex), luminance(ink)].sort((a, b) => a - b);
    const ratio = (hi + 0.05) / (lo + 0.05);
    assert.ok(ratio >= 4.5, `${c.name} (${c.hex}) only reaches ${ratio.toFixed(2)}:1`);
  }
});

test('the swatches are distinct from each other', () => {
  // Two greens nobody can separate is the failure a colour wheel invites, and
  // a curated list only helps if it was actually curated.
  const seen = new Set(CATEGORY_COLOURS.map((c) => c.hex));
  assert.equal(seen.size, CATEGORY_COLOURS.length);
});

test('a picture beats a colour', () => {
  /**
   * A photograph of the thing is more recognisable than any swatch, and one
   * uploaded deliberately must not be overridden by a colour chosen in a
   * hurry.
   */
  assert.equal(chipColour({ colour: '#0f766e', image_id: 'img1' }), null);
  assert.equal(showsPicture({ image_id: 'img1' }), true);
  assert.equal(chipColour({ colour: '#0f766e' }), '#0f766e');
});

test('a category with neither keeps the plain chip', () => {
  /**
   * Nothing is invented. Deriving a colour from a hash of the name — the usual
   * trick — would repaint every till to look like a spreadsheet, in colours
   * that mean nothing because nobody chose them.
   */
  assert.equal(chipColour({}), null);
  assert.equal(chipColour({ colour: '' }), null);
  assert.equal(chipColour({ colour: 'nonsense' }), null, 'and a bad value is no colour, not a crash');
});

test('the form says what is chosen in words, not in hex', () => {
  assert.equal(colourName('#0f766e'), 'Teal');
  assert.equal(colourName(''), 'No colour');
  // A typed colour has no name, so it says itself rather than lying.
  assert.equal(colourName('#123456'), '#123456');
});
