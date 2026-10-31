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

/**
 * Light, dark, or whatever the device says.
 *
 * "System" is the default and stays the default: a phone that switches to dark
 * at sunset should take the app with it. Choosing explicitly is an override,
 * kept on the device rather than in the settings document, one person
 * preferring dark is not a decision for the whole restaurant.
 */
export type ThemeMode = 'system' | 'light' | 'dark';
const THEME_KEY = 'snpos-theme';

export function themeMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export function setThemeMode(mode: ThemeMode): void {
  if (mode === 'system') localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, mode);
  applyThemeMode();
}

/** Put the choice on the root element, where the stylesheet can see it. */
export function applyThemeMode(): void {
  const mode = themeMode();
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
}

export const THEME_MODES: { v: ThemeMode; l: string; hint: string }[] = [
  { v: 'system', l: 'Match my device', hint: 'Switches with your phone or computer.' },
  { v: 'light', l: 'Always light', hint: 'Bright, whatever the device is set to.' },
  { v: 'dark', l: 'Always dark', hint: 'Easier on the eyes in a dim room.' },
];

/**
 * The colours every install was given before anybody chose one.
 *
 * NiceOps is violet now. A setting still holding the old default teal or
 * amber is a colour nobody picked, so it gives way to the stylesheet's own,
 * which also has a lighter shade for dark mode. A colour an owner did choose
 * still wins, as it always has.
 */
const UNCHOSEN = ['#0f766e', '#f59e0b'];
export const isChosenColour = (c?: string | null): c is string => !!c && !UNCHOSEN.includes(c.trim().toLowerCase());

export function applyTheme(t: ThemeInput): void {
  applyThemeMode();
  const root = document.documentElement;
  if (isChosenColour(t.primary_color)) {
    root.style.setProperty('--brand', t.primary_color);
    // Never let a pale brand colour produce white-on-white button text.
    root.style.setProperty('--brand-ink', luminance(t.primary_color) > 0.45 ? '#16202b' : '#ffffff');
  }
  const accent = t.accent_color || t.secondary_color;
  if (isChosenColour(accent)) root.style.setProperty('--accent', accent);
  // The tab icon is drawn from these same colours, so it changes with them.
  applyFavicon();
}
