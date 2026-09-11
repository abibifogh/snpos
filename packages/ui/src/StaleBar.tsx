import { useEffect, useState } from 'react';
import { scriptFrom, pageIsStale, STALE_WORDS } from '@snpos/core';

/** How often to ask. Rare on purpose: a deploy is a thing that happens a few
 *  times a day at most, and this is one request for a small file. */
const ASK_EVERY_MS = 5 * 60_000;

/** The bundle this page is actually running, read off the document itself. */
function runningScript(): string | null {
  try {
    const tag = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
    return tag?.getAttribute('src') ?? null;
  } catch {
    return null;
  }
}

/**
 * Where this app lives, so the right index.html is asked for.
 *
 * Each app is served from its own folder and the service worker is registered
 * with that folder as its scope, so the app's own page is the folder itself.
 * Taken from the bundle's address rather than from the current path, because
 * the current path is wherever somebody has navigated to.
 */
function indexUrl(): string | null {
  const src = runningScript();
  if (!src) return null;
  try {
    const url = new URL(src, window.location.href);
    // .../admin/assets/index-HASH.js -> .../admin/
    return new URL('../', url).href;
  } catch {
    return null;
  }
}

/**
 * Says when the page in front of somebody is not the build that is published.
 *
 * The app cannot know its own age, and until this existed nothing anywhere
 * said a word about it. A stale page reports itself as a missing feature, a
 * link that will not update, or a warning bar that will not clear, and each
 * gets chased as a fault in something else. This asks the server what is
 * published, compares the bundle's name, and says the plain thing.
 *
 * Asked once on opening and every few minutes after, so a screen left up all
 * day through a deploy finds out. `no-store` because the whole question is
 * what the server has, and a cached answer answers a different one.
 */
export function StaleBar() {
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const ask = async () => {
      const where = indexUrl();
      if (!where) return;
      try {
        const res = await fetch(where, { cache: 'no-store' });
        if (!res.ok) return;
        const published = scriptFrom(await res.text());
        if (alive && pageIsStale(runningScript(), published)) setStale(true);
      } catch {
        // Offline, or a host that will not answer. Not knowing is not stale;
        // see pageIsStale. The app goes on working from its caches.
      }
    };
    void ask();
    const timer = setInterval(() => void ask(), ASK_EVERY_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  if (!stale) return null;

  /**
   * Reload, and mean it.
   *
   * An ordinary reload can be served the same old page back by the service
   * worker's caches or the browser's, which is how somebody presses reload
   * three times and reports that reloading does not help. So the caches this
   * app put there are emptied and the worker told to fetch itself again
   * first. Failures are ignored on purpose: a reload that happens anyway is
   * better than an error about why it could not be a thorough one.
   */
  const reload = async () => {
    setBusy(true);
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.update().catch(() => undefined)));
      }
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n).catch(() => undefined)));
      }
    } catch {
      // Nothing to clear, or a browser that will not say. Reload regardless.
    }
    window.location.reload();
  };

  return (
    <div className="offline-bar schema-bar" role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      <span>
        <strong>This page is out of date.</strong> {STALE_WORDS}{' '}
        <button type="button" className="linkish" onClick={() => void reload()} disabled={busy}>
          {busy ? 'Reloading…' : 'Reload now'}
        </button>
      </span>
    </div>
  );
}
