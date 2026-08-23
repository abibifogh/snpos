/**
 * Giving a category a colour, so a till can be read at a glance.
 *
 * The categories along the top of a till are words, and words at arm's length
 * on a busy counter all look like each other. Somebody reaching for Drinks
 * finds it by reading four labels; with a colour they find it by not reading
 * anything, which is the difference between a till you operate and a till you
 * consult.
 *
 * A COLOUR IS THE SECOND CHOICE, not the first. Where a category has a picture
 * that is what shows: a photograph of the thing is more recognisable than any
 * colour, and one that has been uploaded deliberately should not be overridden
 * by a swatch somebody picked in a hurry. Colour is for the many categories
 * that will never have a picture, which on a kitchen side is all of them.
 *
 * NOTHING IS FORCED. A category with neither keeps the plain chip it has
 * always had. Inventing a colour for every category — from a hash of the name,
 * which is the usual trick — would repaint every till in the country to look
 * like a spreadsheet, and the colours would mean nothing because nobody chose
 * them.
 *
 * Pure. Nothing here reads or writes.
 */

/**
 * The swatches offered on the form.
 *
 * A short list rather than a colour wheel. Every one of these is dark enough
 * to carry white text and distinct enough from the others to tell apart across
 * a room, which a free choice does not guarantee — the two failures a wheel
 * invites are a pastel nobody can see and two greens nobody can separate.
 *
 * A typed hex is still accepted; see `colourProblem`. The list is for the
 * ninety per cent who want this done in one tap.
 */
export const CATEGORY_COLOURS: { hex: string; name: string }[] = [
  { hex: '#0f766e', name: 'Teal' },
  { hex: '#1d4ed8', name: 'Blue' },
  { hex: '#6d28d9', name: 'Purple' },
  { hex: '#b91c1c', name: 'Red' },
  { hex: '#c2410c', name: 'Orange' },
  { hex: '#a16207', name: 'Amber' },
  { hex: '#15803d', name: 'Green' },
  { hex: '#0e7490', name: 'Cyan' },
  { hex: '#be185d', name: 'Pink' },
  { hex: '#44403c', name: 'Stone' },
];

const HEX = /^#[0-9a-f]{6}$/i;

/** Tidy what somebody typed, so `0f766e` and `#0F766E` are the same answer. */
export function normaliseColour(value?: string | null): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const withHash = raw.startsWith('#') ? raw : `#${raw}`;
  return HEX.test(withHash) ? withHash.toLowerCase() : '';
}

/**
 * Why this is not a colour, or nothing.
 *
 * Blank is allowed and means "no colour", which is the default and not an
 * error. Anything else has to be a six-digit hex: three-digit shorthand and
 * named colours are refused rather than guessed at, because a value this is
 * stored as is later read back into a swatch and a picker, and both need one
 * shape.
 */
export function colourProblem(value?: string | null): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  return normaliseColour(raw)
    ? null
    : 'That is not a colour. Use one of the swatches, or type a six-digit code like #0f766e.';
}

/** How bright a colour is, 0 to 1. The sRGB relative luminance. */
export function luminance(hex: string): number {
  const clean = normaliseColour(hex);
  if (!clean) return 1;
  const parts = [1, 3, 5].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const [r, g, b] = parts.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Black or white, whichever can actually be read on this colour.
 *
 * Worked out rather than fixed at white. A palette is easy to keep dark; a
 * typed colour is not, and a business that types its own brand yellow would
 * otherwise get white text on it and a category nobody can read. The one thing
 * this must never do is make the till worse than the plain chip it replaced.
 */
export const inkOn = (hex: string): string => (luminance(hex) > 0.45 ? '#16202b' : '#ffffff');

export interface Colourable {
  colour?: string;
  image_id?: string;
}

/**
 * What to paint this category's chip, or nothing at all.
 *
 * Null in two cases, and they are different: no colour was set, or there is a
 * picture, which is the better label and takes precedence. Both come back the
 * same way here because the chip does the same thing with them — nothing —
 * and the caller decides whether to show the picture.
 */
export function chipColour(category: Colourable): string | null {
  if (category.image_id) return null;
  return normaliseColour(category.colour) || null;
}

/** Whether a picture is what this category should be shown by. */
export const showsPicture = (category: Colourable): boolean => !!category.image_id;

/** The name of a swatch, for a form that says what is chosen rather than a hex. */
export function colourName(value?: string | null): string {
  const clean = normaliseColour(value);
  if (!clean) return 'No colour';
  return CATEGORY_COLOURS.find((c) => c.hex === clean)?.name ?? clean;
}
