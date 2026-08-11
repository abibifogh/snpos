/**
 * Surviving a deploy that lands while someone is using the app.
 *
 * Builds name their files with a content hash, so a new version replaces
 * index-ABC.js with index-XYZ.js. A browser holding a cached index.html then
 * asks for a file that is no longer there, gets the app's 404 page back, and
 * refuses to run HTML as JavaScript, leaving a blank screen that looks
 * exactly like the site being down.
 *
 * The deploy keeps the previous build's files around so this should not happen.
 * This is the second line: if a page does fail to load a script or stylesheet,
 * it reloads itself once, past the cache, rather than sitting there blank.
 */

const FLAG = 'snpos-recovering';

/** Watch for the entry files failing, and reload once if they do. */
export function guardStaleBuild(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener(
    'error',
    (e) => {
      const el = e.target as HTMLElement | null;
      if (!el || (el.tagName !== 'SCRIPT' && el.tagName !== 'LINK')) return;
      // Only once. A reload loop is worse than the blank page it is fixing,
      // because the user cannot even read an error in between.
      if (sessionStorage.getItem(FLAG)) return;
      sessionStorage.setItem(FLAG, '1');

      const url = new URL(window.location.href);
      url.searchParams.set('_v', String(Date.now()));
      window.location.replace(url.toString());
    },
    true,
  );
}

/**
 * Called once the app is running.
 *
 * Clears the recovery flag so a genuine failure later still gets its one
 * reload, and tidies the cache-busting parameter out of the address bar, the
 * customer menu's own `?t=` table token has to survive that, so the parameter
 * is removed rather than the query being cleared.
 */
export function bootedOk(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(FLAG);

  const url = new URL(window.location.href);
  if (url.searchParams.has('_v')) {
    url.searchParams.delete('_v');
    window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
  }
}

/**
 * Turn on offline support for this app.
 *
 * Registered from the app's own folder so its scope covers that app and
 * nothing else. Failures are swallowed on purpose: a browser that refuses
 * service workers, or a page opened over plain http during development, should
 * lose the offline behaviour and keep everything else.
 */
export function enableOffline(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    // Relative to the document, which is what scopes it to /admin/, /pos/ and
    // so on rather than to the whole site.
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => undefined);
  });
}
