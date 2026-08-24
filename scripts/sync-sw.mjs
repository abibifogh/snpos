/**
 * Put the shared service worker, the icon and each app's manifest where its
 * build can serve them.
 *
 * A service worker only controls pages inside its own folder, so every app
 * needs its own copy at its own root. Copying at build time rather than
 * checking in four files means there is still only one to edit, four copies of
 * a caching policy would drift, and a stale one is invisible until somebody is
 * looking at last week's app on a dead connection.
 *
 * The manifest is generated rather than checked in for a harder reason: it has
 * to name the address the app is actually served from, and that is only known
 * at build time. The same build runs at a domain root and inside a repository
 * folder on github.io, and a manifest whose start_url points at the wrong one
 * installs an app that opens on somebody else's page.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = join(root, 'packages/ui/src');

const APPS = ['admin', 'menu', 'kitchen', 'pos'];

/**
 * Which apps are installed onto a device and want the whole screen.
 *
 * The till and the kitchen display live on one device each, propped on a
 * counter, doing one job all day. Browser chrome on those is a row of pixels
 * that only ever gets pressed by accident, and an address bar is an invitation
 * to somewhere else.
 *
 * The customer menu is here at the owner's request. Most guests scan and
 * leave, but a phone that offers to keep it is a phone that can be ordered
 * from again without hunting for a sticker, and a tablet left on a table is
 * better off without an address bar too.
 *
 * Not the admin app: it is used on somebody's own laptop between other things,
 * and taking the back button away from a page of settings is a nuisance rather
 * than a kiosk.
 */
const KIOSK = {
  pos: { name: 'NiceOps Till', short: 'Till', description: 'Take orders and record payment.' },
  kitchen: { name: 'NiceOps Kitchen', short: 'Kitchen', description: 'Tickets as they come in.' },
  // Named after the place where one is given, because "Menu" on somebody's
  // home screen a week later says nothing about whose. Set RESTAURANT_NAME as
  // a repository variable to use it.
  menu: {
    name: process.env.RESTAURANT_NAME ? `${process.env.RESTAURANT_NAME} menu` : 'Menu',
    short: process.env.RESTAURANT_NAME || 'Menu',
    description: 'Order from your table.',
  },
};

/*
  The icons go to EVERY app, not only the three that install.

  The admin app has no manifest and never will — it is a desk tool, and taking
  the back button off a page of settings is a nuisance rather than a kiosk. It
  is still a page somebody bookmarks and pins, and a page that names icon files
  it was never given is worse than one that names none: every browser asks for
  them, gets a 404, and falls back to exactly the generic mark this is here to
  replace.
*/
for (const app of APPS) {
  const dir = join(root, 'apps', app, 'public');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ui, 'sw.js'), join(dir, 'sw.js'));
  /*
    Three icons, and the two PNGs are not decoration.

    Android does not install a web app from a manifest that offers only SVG.
    Chrome hands the job to a server that mints a real Android package, and
    that server needs a raster image — given none, it silently gives up on
    installing and drops a BOOKMARK on the home screen instead, which is why
    the till appeared with a little Chrome badge in the corner and opened in a
    browser tab. Nothing said so; it just quietly did the lesser thing.

    So a 192 and a 512 are shipped as files. They are rendered from the same
    icon.svg — see scripts/make-icons.mjs — rather than drawn separately, so
    the three can never disagree about what the mark is.
  */
  for (const file of [
    'icon.svg',
    // Windows builds a taskbar icon out of these small ones. See make-icons:
    // handed only a 512 it downscales by sixteen times, and a smudge is how a
    // taskbar ends up showing the browser's own icon instead.
    'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-64.png',
    'icon-128.png', 'icon-192.png', 'icon-256.png', 'icon-512.png',
  ]) {
    copyFileSync(join(ui, file), join(dir, file));
  }
}

/**
 * Only the app being built gets a manifest, because only it knows its own base.
 *
 * npm runs a workspace script from inside that workspace, so the working
 * directory names the app. Built from the repository root with no app in
 * particular, every kiosk app gets one at the default base, which is what a
 * local `npm run build` wants.
 */
const here = basename(process.cwd());
const building = APPS.includes(here) ? [here] : Object.keys(KIOSK);

for (const app of building) {
  const meta = KIOSK[app];
  if (!meta) continue;

  const dir = join(root, 'apps', app, 'public');
  // Vite's BASE_PATH, the same value the app is built with. Always ends in a
  // slash, so joining a filename onto it needs nothing added.
  const base = process.env.BASE_PATH || '/';

  const manifest = {
    name: meta.name,
    short_name: meta.short,
    description: meta.description,
    // Where it opens. Relative to this file, which is why the manifest has to
    // be generated with the base rather than checked in.
    start_url: base,
    scope: base,
    id: base,
    /**
     * The whole screen, with a ladder down to something workable.
     *
     * `fullscreen` takes the status bar as well, which is right for a device
     * that does one job on a counter. A browser that will not do that falls to
     * `standalone`, which at least loses the address bar, and then to
     * `minimal-ui`. The ladder matters: without it, a browser that does not
     * support the first value silently gives you a browser tab.
     */
    display: 'fullscreen',
    display_override: ['fullscreen', 'standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#f6f7f9',
    theme_color: '#0f766e',
    /*
      The rasters first, because they are what decides whether this installs.

      A 192 and a 512 are what Android checks for. The SVG stays alongside
      them: a browser that prefers it gets a mark that is sharp at any size,
      and one that needs a PNG is no longer left without one.

      `maskable` is the same image on purpose. The tile is full-bleed and the
      receipt sits well inside the circle a launcher crops to, so there is
      nothing a second drawing would do except become the one that gets
      forgotten when the mark changes.
    */
    icons: [
      /*
        Small ones first, and all of them real files.

        Windows makes the taskbar icon by building an .ico, whose sizes run
        from 16 to 256. Offered only a 192 and a 512 it downscales, and a
        sixteen-times downscale of a detailed mark is a smudge — at which
        point the browser's own icon is the more legible thing to show, which
        is exactly what a pinned app was doing.
      */
      { src: 'icon-16.png', sizes: '16x16', type: 'image/png', purpose: 'any' },
      { src: 'icon-32.png', sizes: '32x32', type: 'image/png', purpose: 'any' },
      { src: 'icon-48.png', sizes: '48x48', type: 'image/png', purpose: 'any' },
      { src: 'icon-64.png', sizes: '64x64', type: 'image/png', purpose: 'any' },
      { src: 'icon-128.png', sizes: '128x128', type: 'image/png', purpose: 'any' },
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-256.png', sizes: '256x256', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };

  writeFileSync(join(dir, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(
  `service worker copied into all four apps; manifest written for ${building.filter((a) => KIOSK[a]).join(', ') || 'none'}`,
);
