/**
 * Whether the page somebody is looking at is the build that is published.
 *
 * Three separate complaints turned out to be this one thing: a feature that
 * had shipped days earlier was not on the screen, a link did not show its
 * changes, and a bar reading "the database is behind" would not go away. In
 * every case the deploy had gone out and the browser was still running an
 * older copy of the app. Nothing anywhere said so, so each was reported as a
 * fault in whatever feature happened to be missing, and each was investigated
 * as one.
 *
 * A build cannot tell how old it is by looking at itself. What it can do is
 * ask the server what is published now and compare: every build names its
 * bundle with a content hash, so two different names mean two different
 * builds, and the one in the running page is the older of them by definition.
 *
 * Nothing here touches the network or the document, so it can be tested. The
 * fetching is in StaleBar; this is the reading and the judging.
 */

/**
 * The app's own bundle, out of the HTML the server is serving now.
 *
 * A Vite build puts exactly one module script in index.html, named with the
 * hash of its contents. Matched loosely on purpose: attribute order and
 * quoting are the bundler's business and have changed before.
 */
export function scriptFrom(html: string): string | null {
  const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
  for (const tag of scripts) {
    if (!/\btype\s*=\s*["']?module["']?/i.test(tag)) continue;
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (src) return src[1];
  }
  return null;
}

/**
 * The part of an address that identifies the build.
 *
 * The file name alone, because the same bundle is reached by several
 * addresses — with the site root or without it, absolute or relative — and
 * none of that says anything about which build it is. The hash in the name
 * does.
 */
export function buildName(src: string | null | undefined): string | null {
  if (!src) return null;
  // Anything after the last slash, minus a query string somebody appended.
  const name = src.split(/[?#]/)[0].split('/').filter(Boolean).pop();
  // It has to be a file. An address ending in a folder names no build, and
  // two such addresses differing tells us nothing about which is newer —
  // answering "stale" to that is how a bar cries wolf.
  return name && name.includes('.') ? name : null;
}

/**
 * Is this page an old copy?
 *
 * Only when both are known and they disagree. An unknown either side is the
 * answer "cannot tell", which must read as fresh: a bar telling somebody to
 * reload a page that is already current, shown on a hiccup or an odd host,
 * is a bar they will learn to ignore before the day it matters.
 */
export function pageIsStale(running: string | null | undefined, published: string | null | undefined): boolean {
  const a = buildName(running);
  const b = buildName(published);
  if (!a || !b) return false;
  return a !== b;
}

/**
 * What to say about it.
 *
 * Naming the cause, because the person reading it has almost certainly just
 * been told that a feature exists which they cannot see, and the useful thing
 * is to know that both are true and which button ends it.
 */
export const STALE_WORDS =
  'This page is an older copy of the app. A newer one has been published, so anything recently changed will be '
  + 'missing until you reload.';
