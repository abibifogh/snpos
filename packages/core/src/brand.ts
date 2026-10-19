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
