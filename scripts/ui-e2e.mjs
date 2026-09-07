#!/usr/bin/env node
/**
 * The screens, in a browser, on a clock we control.
 *
 * scripts/e2e.mjs runs the rules against a database in memory. This runs the
 * SCREENS — the real components from packages/ui, mounted in a real Chromium
 * — because the bar till's PIN fault survived three fixes that were each
 * correct about a rule and wrong about the screen. The PIN was checked and
 * matched and the lock opened; what nothing tested was that the sleeping
 * clock underneath then locked it again two milliseconds later. You can only
 * see that by typing the PIN into the pad and looking.
 *
 * The clock is faked (Playwright's page.clock) so "the till sleeps, locks
 * itself, and the bartender arrives in the morning" takes a second rather
 * than nine hours.
 *
 * Needs Chromium: `npx playwright install chromium` once, or the browser that
 * PLAYWRIGHT_BROWSERS_PATH already points at.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const server = await createServer({ configFile: join(here, 'ui-e2e/vite.config.mjs') });
await server.listen();
const url = server.resolvedUrls.local[0];

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  await server.close();
  console.error(`Could not start Chromium: ${e.message}\n\nRun \`npx playwright install chromium\` once and try again.`);
  process.exit(1);
}

let failed = 0;
const scenarios = [];
const scenario = (name, run) => scenarios.push({ name, run });

/** One page per scenario, on a clock that starts at ten in the evening. */
async function fresh() {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.install({ time: new Date('2026-09-06T22:00:00Z') });
  await page.goto(url);
  await page.waitForSelector('#state');

  const till = {
    page,
    errors,
    state: () => page.locator('#state').textContent(),
    log: () => page.evaluate(() => window.__log.slice()),
    lockByHand: () => page.locator('#lock').click(),
    /** Sleep is a timer, so the clock has to pass through it, not jump over it. */
    sleep: () => page.clock.fastForward('01:05'),
    /** Long enough asleep that the till stops being anybody's. */
    lockItself: () => page.clock.fastForward('10:30'),
    morning: () => page.clock.fastForward('08:00:00'),
    async tap(pin) {
      for (const d of pin) {
        await page.locator('.lock-keys button', { hasText: new RegExp(`^${d}$`) }).click();
      }
    },
    enter: () => page.locator('.lock-enter').click(),
    note: () => page.locator('.lock-note').textContent().catch(() => null),
    /**
     * What the till says once everything has settled — including a few
     * seconds of the clock ticking, because the fault was a door that opened
     * and then closed again on the next tick.
     */
    async settled() {
      await page.waitForTimeout(400);
      await page.clock.runFor(3_000);
      await page.waitForTimeout(100);
      return {
        state: await till.state(),
        pad: await page.locator('.idle-locked').count(),
        clock: await page.locator('.idle:not(.idle-locked)').count(),
      };
    },
  };
  return till;
}

const expect = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label}: expected ${w}, got ${g}`);
};

/* ----------------------------------------------------------------- scenes */

scenario('the till locks itself overnight and opens to a PIN in the morning', async () => {
  const till = await fresh();
  await till.sleep();
  expect('asleep', await till.settled(), { state: 'OPEN', pad: 0, clock: 1 });
  await till.lockItself();
  expect('locked itself', await till.settled(), { state: 'LOCKED', pad: 1, clock: 0 });
  await till.morning();
  await till.tap('1234');
  // Open, with the till showing — not the sleeping clock, and not the pad.
  expect('after the PIN', await till.settled(), { state: 'OPEN', pad: 0, clock: 0 });
  const log = await till.log();
  expect('one lock, one unlock, no second lock', log.map((l) => l.split(' ').slice(1).join(' ')),
    ['onLock', 'onUnlock Regina']);
  expect('no errors', till.errors, []);
});

scenario('locked by hand, left for twelve minutes, opened by a PIN', async () => {
  // The commonest case at a bar: Lock, go and serve, come back later.
  const till = await fresh();
  await till.lockByHand();
  await till.sleep();
  await till.lockItself();
  expect('still locked', await till.settled(), { state: 'LOCKED', pad: 1, clock: 0 });
  await till.tap('1234');
  expect('after the PIN', await till.settled(), { state: 'OPEN', pad: 0, clock: 0 });
  expect('log', (await till.log()).map((l) => l.split(' ').slice(1).join(' ')),
    ['onLock', 'onUnlock Regina']);
});

scenario('locked by hand and opened straight away', async () => {
  const till = await fresh();
  await till.lockByHand();
  await till.tap('1234');
  expect('after the PIN', await till.settled(), { state: 'OPEN', pad: 0, clock: 0 });
});

scenario('a five-digit PIN opens it too', async () => {
  // Four digits is not final while six are allowed, so this must not be
  // refused at four and cleared before the fifth lands.
  const till = await fresh();
  await till.lockByHand();
  await till.sleep();
  await till.lockItself();
  await till.tap('13795');
  expect('after the PIN', await till.settled(), { state: 'OPEN', pad: 0, clock: 0 });
  expect('who', (await till.log()).at(-1).split(' ').slice(1).join(' '), 'onUnlock Betty');
});

scenario('a wrong PIN is refused, and says so', async () => {
  const till = await fresh();
  await till.lockByHand();
  await till.tap('9999');
  await till.enter();
  expect('still locked', await till.settled(), { state: 'LOCKED', pad: 1, clock: 0 });
  expect('the note', await till.note(), 'That PIN was not recognised.');
  // And the right one still works after a wrong one.
  await till.tap('1234');
  expect('after the right PIN', await till.settled(), { state: 'OPEN', pad: 0, clock: 0 });
});

/* ------------------------------------------------------------------- run */

for (const { name, run } of scenarios) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

await browser.close();
await server.close();
console.log(failed ? `\n${failed} screen check(s) failed` : `\n${scenarios.length} screen checks passed`);
process.exit(failed ? 1 : 0);
