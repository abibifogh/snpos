/**
 * What the system is called, in one place.
 *
 * Every tab title, installed-app name and sign-in fallback is built from
 * these, so renaming the product is a change to PRODUCT_NAME and nothing
 * else. Titles read "NiceOps Till", never "NiceOps POS, Terminal": a comma in
 * a browser tab looks like a sentence cut off, and the same app should not be
 * a Terminal in one place and a Till in another.
 *
 * scripts/sync-sw.mjs and each app's index.html cannot import this, so a test
 * holds them to it (brand.test.ts).
 */
export const PRODUCT_NAME = 'NiceOps';

export type AppKey = 'admin' | 'pos' | 'kitchen' | 'menu';

/** What each app is called on its own, as on a home-screen icon. */
export const APP_NAMES: Record<AppKey, string> = {
  admin: 'Admin',
  pos: 'Till',
  kitchen: 'Kitchen',
  menu: 'Menu',
};

/** "NiceOps Till": the tab title and installed name of an app. */
export function appTitle(app: AppKey): string {
  return `${PRODUCT_NAME} ${APP_NAMES[app]}`;
}

/**
 * "Orders · NiceOps Admin": the tab title of one page.
 *
 * The page first, because a tab strip cuts titles from the end and six Admin
 * tabs that all start "NiceOps Admin…" cannot be told apart.
 */
export function pageTitle(page: string | null | undefined, app: AppKey): string {
  const here = (page ?? '').trim();
  return here && here !== APP_NAMES[app] ? `${here} · ${appTitle(app)}` : appTitle(app);
}

/**
 * NiceOps' own colours: violet for what you press, ember for what is late.
 *
 * The brand colour on the settings row was filled with a default when the
 * business was set up (teal, with an amber second colour) before NiceOps had
 * colours of its own. Nobody chose those, so wherever the colour is used
 * (the screens, emails, PDFs) the old defaults give way to these. A colour an
 * owner did choose always wins. functions/notify/src/brand.js is the same rule
 * for the server; a parity test holds the two together.
 */
export const BRAND_VIOLET = '#6A4DFF';
export const BRAND_EMBER = '#E9772E';
const UNCHOSEN_PRIMARY = '#0f766e';
const UNCHOSEN_SECOND = '#f59e0b';

/** Whether this is a colour somebody picked, rather than empty or an old default. */
export const isChosenColour = (c?: string | null): c is string => {
  const v = (c ?? '').trim().toLowerCase();
  return v !== '' && v !== UNCHOSEN_PRIMARY && v !== UNCHOSEN_SECOND;
};

/** The colour to draw the brand in: the owner's, or violet. */
export const brandColour = (c?: string | null): string => (isChosenColour(c) ? c.trim() : BRAND_VIOLET);

/** The second colour: the owner's, or ember. */
export const secondColour = (c?: string | null): string => (isChosenColour(c) ? c.trim() : BRAND_EMBER);
