/**
 * Render the PNG icons from the one SVG.
 *
 * Android will not install a web app from a manifest offering only SVG. Chrome
 * hands the job to a server that mints a real Android package, and that server
 * needs a raster image — given none it silently gives up on installing and
 * drops a bookmark on the home screen instead, complete with a little browser
 * badge in the corner. Nothing says so; it just quietly does the lesser thing.
 *
 * So the two sizes Android checks for are committed as files. They are
 * RENDERED from icon.svg rather than drawn separately, so a mark that changes
 * cannot leave the home-screen tile showing the old one.
 *
 * Run by hand after changing icon.svg, not in the build. It needs a browser,
 * and a deploy that fails because a CI runner has no Chromium is a worse
 * outcome than two files somebody regenerates on the rare day the mark moves.
 *
 *   node scripts/make-icons.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ui = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'ui', 'src');

/** Where Playwright's browsers live in this image, and the usual alternatives. */
const CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);

const chrome = CANDIDATES.find((p) => {
  try { execFileSync(p, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
});

if (!chrome) {
  console.error(
    'No Chromium found. Set CHROME_PATH to a browser binary and run again.\n'
    + 'The icons already in packages/ui/src are fine unless icon.svg has changed.',
  );
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'snpos-icons-'));
copyFileSync(join(ui, 'icon.svg'), join(work, 'icon.svg'));

/*
  The sizes each platform actually reaches for.

  192 and 512 are Android's. The small ones are WINDOWS: pinning an installed
  app to the taskbar builds an .ico, and the sizes in one are 16 through 256.
  Chromium will downscale a 512 to fill them, and downscaling a mark with fine
  detail by sixteen times produces a smudge — which is how a taskbar ends up
  showing the browser's own icon as the more legible option.

  256 is the largest a Windows taskbar or Start tile uses; 48 is the classic
  shortcut size; 32 and 16 are the title bar and the file list.
*/
for (const size of [16, 32, 48, 64, 128, 192, 256, 512]) {
  const page = join(work, `${size}.html`);
  // No margin, no scrollbars, and a transparent page behind it: the icon's own
  // rounded tile is the whole image, and a white page around it would show up
  // as square corners on a launcher that rounds them itself.
  writeFileSync(
    page,
    '<!doctype html><meta charset="utf-8">'
    + `<style>html,body{margin:0;padding:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style>`
    + '<img src="icon.svg">',
  );
  execFileSync(chrome, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--default-background-color=00000000',
    `--screenshot=${join(ui, `icon-${size}.png`)}`,
    `--window-size=${size},${size}`,
    `file://${page}`,
  ], { stdio: 'ignore' });
  console.log(`wrote packages/ui/src/icon-${size}.png`);
}

console.log('Now run a build so each app picks them up, or just commit and deploy.');
