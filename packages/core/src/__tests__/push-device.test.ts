import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pushSupport, supportWords, deviceLabel, keyBytes, isAppleMobile, sameKey, type PushEnv,
} from '../push-device.ts';

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  // An iPad asks for desktop sites and says it is a Mac.
  ipadAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
};

const env = (over: Partial<PushEnv> = {}): PushEnv => ({
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: 'default',
  standalone: false,
  userAgent: UA.chromeMac,
  maxTouchPoints: 0,
  publicKey: 'BKey',
  ...over,
});

test('a desktop browser with everything is ready', () => {
  assert.equal(pushSupport(env()), 'ok');
  assert.equal(pushSupport(env({ userAgent: UA.chromeAndroid })), 'ok', 'Android needs no install');
});

test('an iPhone in a browser tab is told to add it to the Home Screen, not that it cannot', () => {
  /*
    Safari in an iPhone tab has no push manager at all, so a plain feature
    check says "unsupported" — true of the tab, false of the phone, and the
    reason somebody would conclude the feature does not exist.
  */
  const tab = env({ userAgent: UA.safariIphone, hasPushManager: false, standalone: false });
  assert.equal(pushSupport(tab), 'needs-install');
  assert.match(String(supportWords('needs-install')), /Add to Home Screen/);
  // From the Home Screen it works like anything else.
  assert.equal(pushSupport(env({ userAgent: UA.safariIphone, standalone: true })), 'ok');
});

test('an iPad pretending to be a Mac is still an iPad', () => {
  assert.equal(isAppleMobile(UA.ipadAsMac, 5), true);
  assert.equal(isAppleMobile(UA.ipadAsMac, 0), false, 'a real Mac has no touch points');
  assert.equal(pushSupport(env({ userAgent: UA.ipadAsMac, maxTouchPoints: 5 })), 'needs-install');
});

test('refused once is refused until the browser\'s own settings say otherwise', () => {
  assert.equal(pushSupport(env({ permission: 'denied' })), 'blocked');
  // Where to go, because a page cannot ask again.
  assert.match(String(supportWords('blocked')), /site settings/);
});

test('a browser with no push is told which ones have it', () => {
  assert.equal(pushSupport(env({ hasPushManager: false })), 'unsupported');
  assert.match(String(supportWords('unsupported')), /Chrome, Edge, Firefox or Safari/);
});

test('no server key yet comes before everything, and says what fixes it', () => {
  assert.equal(pushSupport(env({ publicKey: '' })), 'no-key');
  assert.match(String(supportWords('no-key')), /Provision Appwrite/);
  assert.equal(supportWords('ok'), null);
});

test('devices are named the way people would name them', () => {
  assert.equal(deviceLabel(UA.chromeMac), 'Chrome on Mac');
  // Edge says it is Chrome, and Chrome says it is Safari.
  assert.equal(deviceLabel(UA.edgeWin), 'Edge on Windows');
  assert.equal(deviceLabel(UA.chromeAndroid), 'Chrome on Android');
  assert.equal(deviceLabel(UA.safariIphone), 'Safari on iPhone');
  assert.equal(deviceLabel(UA.firefoxLinux), 'Firefox on Linux');
  assert.equal(deviceLabel(UA.ipadAsMac, 5), 'Safari on iPad');
  assert.equal(deviceLabel(''), 'A browser');
});

test('the server key becomes the 65 bytes a browser subscribes with', () => {
  const key = 'BB4YUy_UdUwC8wQdnHXOszuD_9gax85P6ILMscmLxYlupGwxHE4v9A3ZajZT5uRURdMt_khuztdcepDGoYiBwKM';
  const bytes = keyBytes(key);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4, 'an uncompressed point');
  // Round trip, so the alphabet and padding were both put back correctly.
  assert.equal(Buffer.from(bytes).toString('base64url'), key);
});

test('a leftover subscription is reused only when it was made for this key', () => {
  const key = keyBytes('BB4YUy_UdUwC8wQdnHXOszuD_9gax85P6ILMscmLxYlupGwxHE4v9A3ZajZT5uRURdMt_khuztdcepDGoYiBwKM');
  assert.equal(sameKey(key.slice().buffer, key), true);
  assert.equal(sameKey(key.slice(), key), true, 'a view works as well as a buffer');
  const other = key.slice();
  other[10] ^= 1;
  assert.equal(sameKey(other, key), false);
  // Unknown is treated as different: resubscribing costs nothing, keeping a
  // bad one costs every notification.
  assert.equal(sameKey(null, key), false);
});
