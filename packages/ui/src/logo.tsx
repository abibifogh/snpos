/**
 * The system mark.
 *
 * A serving cloche: the one shape that reads as "food is coming" at any size,
 * including the 16 pixels a browser tab gives you. It is drawn from the theme
 * variables rather than from a fixed palette, so when an admin changes the
 * restaurant's colours the icon changes with them, no new image to upload, no
 * redeploy.
 */

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
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">',
    rounded ? `<rect width="64" height="64" rx="14" fill="${c.brand}"/>` : '',
    // The dome, sitting on its counter.
    `<path d="M11 41a21 21 0 0 1 42 0z" fill="${body}"/>`,
    `<rect x="7" y="44" width="50" height="7" rx="3.5" fill="${body}"/>`,
    // The handle, in the accent colour, the one spot of contrast that makes
    // the silhouette read as a cloche rather than a hill.
    `<circle cx="32" cy="15" r="4.5" fill="${c.accent}"/>`,
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
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
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
  /** Draw the brand-coloured tile behind the cloche. */
  tile?: boolean;
  title?: string;
}) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label={title} style={{ display: 'block' }}>
      {tile && <rect width="64" height="64" rx="14" fill="var(--brand)" />}
      <path d="M11 41a21 21 0 0 1 42 0z" fill={tile ? 'var(--brand-ink)' : 'var(--brand)'} />
      <rect x="7" y="44" width="50" height="7" rx="3.5" fill={tile ? 'var(--brand-ink)' : 'var(--brand)'} />
      <circle cx="32" cy="15" r="4.5" fill="var(--accent)" />
    </svg>
  );
}
