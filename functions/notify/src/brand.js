/**
 * NiceOps' own colours, for emails and PDFs. Mirrors brandColour in
 * packages/core/src/brand.ts: the old defaults nobody chose (teal, amber)
 * give way to violet, and a colour an owner did choose always wins.
 */
export const BRAND_VIOLET = '#6A4DFF';
const UNCHOSEN = ['#0f766e', '#f59e0b'];

/** The colour to draw the brand in: the owner's, or violet. */
export function brandColour(c) {
  const v = String(c ?? '').trim();
  return v !== '' && !UNCHOSEN.includes(v.toLowerCase()) ? v : BRAND_VIOLET;
}
