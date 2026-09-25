import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, createDecipheriv, hkdfSync, verify } from 'node:crypto';
import {
  b64u, fromB64u, makeKeys, encrypt, vapidHeader, outcomeOf, send,
  // Plain JavaScript importing only node:crypto, so it can be tested from here
  // without a push service.
} from '../../../../functions/notify/src/webpush.js';

/*
  An encryption format is only worth testing against somebody else's answer.
  A round trip through a decryptor written alongside the encryptor passes just
  as happily when both halves share a mistake — so the first test below is a
  KNOWN ANSWER: these inputs were run through http_ece, the implementation
  web-push (and so most servers that talk to browsers' push services) is built
  on, and this is what it produced. Fifty random cases were checked
  byte-for-byte against it the same way before this one was pinned.
*/
const VECTOR = {
  uaPrivate: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
  p256dh: 'BB4YUy_UdUwC8wQdnHXOszuD_9gax85P6ILMscmLxYlupGwxHE4v9A3ZajZT5uRURdMt_khuztdcepDGoYiBwKM',
  auth: 'AwMDAwMDAwMDAwMDAwMDAw',
  ephemeral: 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk',
  salt: 'BQUFBQUFBQUFBQUFBQUFBQ',
  plaintext: '{"title":"Count waiting","body":"Cola, 2 short"}',
  expected: 'BQUFBQUFBQUFBQUFBQUFBQAAEABBBHE1-k_ZOgnc6Yu_aBtL_PUOfA1jVOYq-wv_KjQpYXhl7UwfAt25Aj7lalV-UV1qncZsEfIglg3llDNN9Yh3ZyQ90jNoSEkYrtQ3IYVqZpwXgre9o6go7b7vnribMf3bDlOKAqTdLBvZRN3lVWDsKxMevVjOAFv1diHTQFVSAuBTRg',
};

test('the encryption matches the reference implementation byte for byte', () => {
  const out = encrypt(VECTOR.plaintext, { p256dh: VECTOR.p256dh, auth: VECTOR.auth }, {
    ephemeral: fromB64u(VECTOR.ephemeral),
    salt: fromB64u(VECTOR.salt),
  });
  assert.equal(b64u(out), VECTOR.expected);
});

/**
 * The browser's side, written from RFC 8188 and 8291 — so that the test above
 * is not the only thing standing between a typo and every phone silently
 * dropping what it is sent.
 */
function browserDecrypts(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);

  const ua = createECDH('prime256v1');
  ua.setPrivateKey(uaPrivate);
  const shared = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  // The last record ends in 0x02, then nothing. See RFC 8188 section 2.
  assert.equal(padded[padded.length - 1], 2);
  return padded.subarray(0, padded.length - 1).toString();
}

test('a browser can read what is sent, with a fresh key and salt each time', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const keys = { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 1)) };
  const a = encrypt('hello', keys);
  const b = encrypt('hello', keys);
  // Never the same bytes twice: reusing a key or salt is what lets somebody
  // who saw two messages learn about both.
  assert.notEqual(b64u(a), b64u(b));
  assert.equal(browserDecrypts(a, ua.getPrivateKey(), Buffer.alloc(16, 1)), 'hello');
  assert.equal(browserDecrypts(b, ua.getPrivateKey(), Buffer.alloc(16, 1)), 'hello');
});

test('a subscription with unusable keys is refused rather than sent garbage', () => {
  assert.throws(() => encrypt('x', { p256dh: b64u(Buffer.alloc(10)), auth: VECTOR.auth }), /not a P-256/);
  assert.throws(() => encrypt('x', { p256dh: VECTOR.p256dh, auth: b64u(Buffer.alloc(4)) }), /wrong length/);
});

test('a message too long for one record says so instead of being cut', () => {
  assert.throws(
    () => encrypt('x'.repeat(5000), { p256dh: VECTOR.p256dh, auth: VECTOR.auth }),
    /too long/,
  );
});

/* -------------------------------------------------------------------- VAPID */

test('the server key pair is the shape browsers and push services expect', () => {
  const k = makeKeys();
  // A 65-byte uncompressed point is what PushManager.subscribe takes, and a
  // 32-byte scalar is the private half.
  assert.equal(fromB64u(k.publicKey).length, 65);
  assert.equal(fromB64u(k.publicKey)[0], 4);
  assert.equal(fromB64u(k.privateKey).length, 32);
  // Two runs never make the same key.
  assert.notEqual(makeKeys().publicKey, k.publicKey);
});

test('every request is signed so only this server can use its subscriptions', () => {
  const k = makeKeys();
  const now = Date.parse('2026-09-24T10:00:00Z');
  const header = vapidHeader({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc:def',
    publicKey: k.publicKey,
    privateKey: k.privateKey,
    subject: 'https://pos.example.com',
    now,
  });

  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, 'the header shape RFC 8292 names');
  const [head, claims, sig] = (m?.[1] ?? '').split('.');
  assert.equal(m?.[2], k.publicKey);

  const pub = fromB64u(k.publicKey);
  const key = createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) },
  });
  // Raw r‖s, 64 bytes. DER is the default and every push service refuses it.
  assert.equal(fromB64u(sig ?? '').length, 64);
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64u(sig ?? '')));

  const c = JSON.parse(fromB64u(claims ?? '').toString());
  // The service's own origin, never the whole endpoint: anything else is refused.
  assert.equal(c.aud, 'https://fcm.googleapis.com');
  assert.equal(c.exp, now / 1000 + 12 * 3600, 'well inside the day the RFC allows');
  assert.equal(c.sub, 'https://pos.example.com');
});

/* --------------------------------------------------------------------- send */

test('what a push service says decides what happens to the subscription', () => {
  assert.equal(outcomeOf(201), 'sent');
  // Gone for good: the browser unsubscribed or was reset. Deleted, or every
  // future alert tries a dead address first.
  assert.equal(outcomeOf(410), 'gone');
  assert.equal(outcomeOf(404), 'gone');
  // Anything else may well work next time, so the subscription is kept.
  assert.equal(outcomeOf(429), 'failed');
  assert.equal(outcomeOf(500), 'failed');
  assert.equal(outcomeOf(403), 'failed');
});

test('a send is one signed, encrypted POST with the headers push services require', async () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.alloc(16, 2);
  const keys = makeKeys();
  const calls: { url: string; init: RequestInit }[] = [];

  const res = await send({
    subscription: { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/xyz', p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) },
    payload: { title: 'Count waiting', body: 'Cola, 2 short' },
    keys,
    subject: 'https://pos.example.com',
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('', { status: 201 });
    }) as unknown as typeof fetch,
  });

  assert.equal(res.outcome, 'sent');
  assert.equal(calls.length, 1);
  const h = calls[0]?.init.headers as Record<string, string>;
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal(h['Content-Encoding'], 'aes128gcm');
  assert.match(h.Authorization ?? '', /^vapid t=/);
  assert.equal(h.TTL, String(24 * 3600), 'a phone off until tomorrow still gets it');
  assert.equal(h.Urgency, 'high', 'a phone saving battery holds back anything less');

  const body = calls[0]?.init.body as Buffer;
  assert.deepEqual(JSON.parse(browserDecrypts(body, ua.getPrivateKey(), auth)), {
    title: 'Count waiting', body: 'Cola, 2 short',
  });
});

test('a subscription that has gone is reported as gone, with the service\'s reason', async () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const res = await send({
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16)) },
    payload: { title: 't' },
    keys: makeKeys(),
    fetchImpl: (async () => new Response('push subscription has unsubscribed or expired', { status: 410 })) as unknown as typeof fetch,
  });
  assert.equal(res.outcome, 'gone');
  assert.match(res.detail ?? '', /expired/);
});

test('a network failure is a failed send, not a crash and not a dead subscription', async () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const res = await send({
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16)) },
    payload: { title: 't' },
    keys: makeKeys(),
    fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch,
  });
  assert.equal(res.outcome, 'failed');
});

test('a subscription stored with broken keys is cleaned away rather than retried for ever', async () => {
  let called = false;
  const res = await send({
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'bad', auth: 'bad' },
    payload: { title: 't' },
    keys: makeKeys(),
    fetchImpl: (async () => { called = true; return new Response('', { status: 201 }); }) as unknown as typeof fetch,
  });
  assert.equal(res.outcome, 'gone');
  assert.equal(called, false, 'nothing is sent that no browser could read');
});
