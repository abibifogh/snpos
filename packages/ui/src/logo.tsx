/**
 * The system mark.
 *
 * A receipt, torn off at the bottom.
 *
 * It used to be a serving cloche, which was right when this was a restaurant
 * system and wrong the moment it was not. A business running a bistro, a bar
 * and a craft shop off one till was being told by its own home screen that
 * this is a thing for food — and somebody selling a woven basket had a silver
 * dome sitting on the tablet in front of them.
 *
 * A receipt is what all three have in common. It is what the till produces
 * whether the thing sold was cooked, poured or carried in by a maker, and it
 * is the one shape that survives being drawn at the sixteen pixels a browser
 * tab allows: the torn edge reads even when nothing else does.
 *
 * Drawn from the theme variables rather than a fixed palette, so when an admin
 * changes the business's colours the mark changes with them — no new image to
 * upload, no redeploy.
 */

/**
 * The slip itself, as one path, shared by every drawing of the mark.
 *
 * Written once because there are four of them — the runtime SVG, the React
 * component, and a static file per installable app — and a mark that differs
 * between the tab and the home screen is a mark nobody recognises as one
 * thing.
 *
 * The bottom is eight teeth of four units each across the slip's full width,
 * alternating up and down so it ends level with where it started. A tear drawn
 * any shallower stops reading at tab size, which is the only size that is
 * genuinely hard.
 */
export const RECEIPT =
  'M16 15a4 4 0 0 1 4-4h24a4 4 0 0 1 4 4v36l-4-3.5-4 3.5-4-3.5-4 3.5-4-3.5-4 3.5-4-3.5-4 3.5Z';

export interface BrandColours {
  brand: string;
  ink: string;
  accent: string;
}

/** Read the colours the theme is currently using. */
export function currentBrand(): BrandColours {
  const css = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => (css?.getPropertyValue(name) || '').trim() || fallback;
  return {
    brand: read('--brand', '#0f766e'),
    ink: read('--brand-ink', '#ffffff'),
    accent: read('--accent', '#f59e0b'),
  };
}

/**
 * The mark as raw SVG.
 *
 * `rounded` fills the tile with the brand colour, which is what a favicon or a
 * home-screen icon needs. Without it the cloche is drawn on nothing, for
 * sitting inside a page that already has a background.
 */
export function logoSvg(c: BrandColours, rounded = true): string {
  const body = rounded ? c.ink : c.brand;
  // The paper's own lines are drawn in the tile colour, so they read as holes
  // in the receipt rather than as marks on top of it. Off-tile, where there is
  // no tile behind them, they would disappear — so they are simply left out.
  const rule = rounded ? c.brand : 'none';
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">',
    rounded ? `<rect width="64" height="64" rx="14" fill="${c.brand}"/>` : '',
    // The slip, with a torn bottom edge. The tear is what makes it a receipt
    // at any size; without it this is a rectangle.
    `<path d="${RECEIPT}" fill="${body}"/>`,
    rounded ? `<rect x="22" y="21" width="20" height="3" rx="1.5" fill="${rule}"/>` : '',
    rounded ? `<rect x="22" y="28" width="20" height="3" rx="1.5" fill="${rule}"/>` : '',
    rounded ? `<rect x="22" y="35" width="13" height="3" rx="1.5" fill="${rule}"/>` : '',
    // The total, in the accent colour: the one spot of contrast, and the line
    // on a receipt anybody actually looks at.
    `<rect x="22" y="42" width="20" height="4" rx="2" fill="${c.accent}"/>`,
    '</svg>',
  ].join('');
}

/** The mark as a data URI, for `<link rel="icon">` or an `<img src>`. */
export const logoDataUri = (c: BrandColours, rounded = true): string =>
  `data:image/svg+xml,${encodeURIComponent(logoSvg(c, rounded))}`;

/**
 * Point the browser tab at the current colours.
 *
 * Called from `applyTheme`, so every app picks this up simply by applying the
 * restaurant's settings the way it already does.
 */
export function applyFavicon(c: BrandColours = currentBrand()): void {
  if (typeof document === 'undefined') return;
  /*
    ITS OWN LINK, beside the static ones rather than on top of them.

    This used to take the first `link[rel="icon"]` it found and rewrite it as
    an SVG data URI. Harmless while the pages declared no icon at all — and
    the moment they declared real PNG files, it would have overwritten the
    first of them with something Windows cannot build a taskbar icon out of.

    Both belong in the head. The tab takes the live-coloured SVG; anything
    making a shortcut, a tile or an .ico takes the PNG it needs by size.
  */
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-live]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.dataset.live = 'brand';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = logoDataUri(c);

  // Colours the address bar on Android and the title bar of an installed app.
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = c.brand;
}

/** The mark, for headers and sign-in screens. Follows the theme live. */
export function Logo({
  size = 32,
  tile = true,
  title = 'NiceOps POS',
}: {
  size?: number;
  /** Draw the brand-coloured tile behind the receipt. */
  tile?: boolean;
  title?: string;
}) {
  const body = tile ? 'var(--brand-ink)' : 'var(--brand)';
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label={title} style={{ display: 'block' }}>
      {tile && <rect width="64" height="64" rx="14" fill="var(--brand)" />}
      <path d={RECEIPT} fill={body} />
      {/* The paper's lines are the tile showing through, so they only exist
          where there is a tile. Off-tile they would be invisible anyway. */}
      {tile && (
        <>
          <rect x="22" y="21" width="20" height="3" rx="1.5" fill="var(--brand)" />
          <rect x="22" y="28" width="20" height="3" rx="1.5" fill="var(--brand)" />
          <rect x="22" y="35" width="13" height="3" rx="1.5" fill="var(--brand)" />
        </>
      )}
      <rect x="22" y="42" width="20" height="4" rx="2" fill="var(--accent)" />
    </svg>
  );
}
