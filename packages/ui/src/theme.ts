/**
 * Apply the restaurant's branding at runtime.
 *
 * Colours live in the settings document rather than in the build, so an admin
 * changing them takes effect on the next load without anyone redeploying.
 */
import { applyFavicon } from './logo';

export interface ThemeInput {
  primary_color?: string;
  secondary_color?: string;
  accent_color?: string;
}

/** Relative luminance, per WCAG, for picking readable text on a brand colour. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

export function applyTheme(t: ThemeInput): void {
  const root = document.documentElement;
  if (t.primary_color) {
    root.style.setProperty('--brand', t.primary_color);
    // Never let a pale brand colour produce white-on-white button text.
    root.style.setProperty('--brand-ink', luminance(t.primary_color) > 0.45 ? '#16202b' : '#ffffff');
  }
  if (t.accent_color || t.secondary_color) {
    root.style.setProperty('--accent', (t.accent_color || t.secondary_color) as string);
  }
  // The tab icon is drawn from these same colours, so it changes with them.
  applyFavicon();
}
