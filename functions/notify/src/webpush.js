/**
 * Web Push, written against the two RFCs rather than pulled in as a package.
 *
 * WHY BY HAND. The function is deployed on its own and every package it
 * carries is one more thing that has to install on Appwrite's build and in
 * this repository's tests. What Web Push actually needs is four primitives —
 * an elliptic-curve key agreement, a key derivation, AES-GCM and an ES256
 * signature — and Node has had all four in node:crypto since before the
 * runtime this function runs on. The same reasoning as the PDF toolkit next
 * door: when the whole of the thing fits in one readable file, owning it is
 * cheaper than depending on it.
 *
 * It is CHECKED against the reference implementation byte for byte. See
 * webpush.test.ts: with the same keys and salt this produces exactly what the
 * library browsers' push services are tested against produces, which is the
 * only kind of test worth having for an encryption format — a round trip
 * through my own decryptor would pass just as happily if both halves shared a
 * mistake.
 *
 * Two standards, one each:
 *
 *   RFC 8291  the message is encrypted to the one browser that subscribed, so
 *             the push service carrying it (Google's, Apple's, Mozilla's) sees
 *             nothing but ciphertext;
 *   RFC 8292  "VAPID" — every request is signed with this server's key, so a
 *             push service only accepts messages for a subscription from the
 *             server it was made for.
 *
 * Pure apart from `send`, and `send` takes its fetch as an argument.
 */

import {
  createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv, sign,
} from 'node:crypto';

/* ------------------------------------------------------------- encodings */

/** base64url, the alphabet every part of Web Push is written in. */
export const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const fromB64u = (s) => Buffer.from(
  String(s).replace(/-/g, '+').replace(/_/g, '/'),
  'base64',
);

/* ------------------------------------------------------------------- keys */

/**
 * A fresh key pair for this server, as the two strings that get stored.
 *
 * Made ONCE, by provisioning, and never again. Every browser that subscribes
 * is bound to the public half; a new pair would silently orphan every device
 * that had turned notifications on, and they would simply stop arriving.
 *
 * @returns {{ publicKey: string, privateKey: string }} base64url: the 65-byte
 *   uncompressed point the browser is given, and the 32-byte private scalar.
 */
export function makeKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  return { publicKey: b64u(pub), privateKey: jwk.d };
}

/** The private key as something node:crypto can sign with. */
function signingKey(publicKey, privateKey) {
  const pub = fromB64u(publicKey);
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
      d: privateKey,
    },
  });
}

/* ------------------------------------------------------------- encryption */

const RECORD_SIZE = 4096;

/**
 * RFC 8291: encrypt one message to one subscription.
 *
 * A fresh key pair and salt per message, which is what the format is built
 * on — reusing either would let anybody who saw two messages learn something
 * about both. `ephemeral` and `salt` are parameters only so a test can pin
 * them against a known answer; nothing else passes them.
 *
 * @param {Buffer|string} plaintext
 * @param {{ p256dh: string, auth: string }} keys  From the browser's subscription.
 * @param {{ ephemeral?: Buffer, salt?: Buffer }} [fixed]
 * @returns {Buffer} The whole request body: header, then one record.
 */
export function encrypt(plaintext, keys, fixed = {}) {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  if (uaPublic.length !== 65) throw new Error('That subscription\'s key is not a P-256 public key.');
  if (authSecret.length !== 16) throw new Error('That subscription\'s auth secret is the wrong length.');

  const ecdh = createECDH('prime256v1');
  if (fixed.ephemeral) ecdh.setPrivateKey(fixed.ephemeral);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed.salt ?? randomBytes(16);

  // hkdfSync is Extract then Expand, which is exactly the shape both steps of
  // the RFC take: first mixing the browser's auth secret into the shared
  // secret, then deriving the key and nonce from that and the salt.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  // One record, so it is also the last: the delimiter says so. No padding
  // beyond it — these messages say nothing whose length is worth hiding.
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  if (padded.length + 16 > RECORD_SIZE) {
    throw new Error('That notification is too long to send in one piece. Say less.');
  }
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/* ------------------------------------------------------------------ VAPID */

/**
 * RFC 8292: the signed header that says which server sent this.
 *
 * `aud` is the push service's own origin, never the full endpoint — the
 * service checks it and refuses anything else. Twelve hours of life, well
 * inside the day the RFC allows, so a clock a few minutes off cannot produce
 * a token the service calls expired.
 *
 * `sub` is how the push service reaches a human if this server misbehaves.
 * The app's own address where there is one, the house mailbox otherwise.
 */
export function vapidHeader({ endpoint, publicKey, privateKey, subject, now = Date.now() }) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({
    aud,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject || 'mailto:admin@localhost',
  }));
  const unsigned = `${head}.${claims}`;
  // ieee-p1363 is the raw r‖s a JWT wants. The default is DER, which every
  // push service refuses with a 403 that says nothing about why.
  const sig = sign('sha256', Buffer.from(unsigned), {
    key: signingKey(publicKey, privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${publicKey}`;
}

/* ------------------------------------------------------------------ send */

/**
 * What a push service's answer means for the subscription.
 *
 *   sent      2xx — the service has it and will deliver when it can
 *   gone      404/410 — the browser unsubscribed, or was reset or uninstalled.
 *             The subscription will never work again and should be deleted,
 *             or every future alert quietly tries a dead address first.
 *   failed    anything else — a bad key, a rate limit, a service having a bad
 *             hour. Kept, because the next try may well work.
 */
export function outcomeOf(status) {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 404 || status === 410) return 'gone';
  return 'failed';
}

/**
 * Send one notification to one subscription.
 *
 * Urgency high, because the only things sent this way are things somebody
 * should look at now — a phone saving battery holds back "normal" messages.
 * A day to live: if the phone is off until tomorrow it still arrives, and a
 * count held for a day is still held.
 *
 * @param {object} opts
 * @param {{ endpoint: string, p256dh: string, auth: string }} opts.subscription
 * @param {object} opts.payload         What the service worker shows. JSON-encoded here.
 * @param {{ publicKey: string, privateKey: string }} opts.keys
 * @param {string} [opts.subject]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ outcome: 'sent'|'gone'|'failed', status: number, detail?: string }>}
 */
export async function send({ subscription, payload, keys, subject, fetchImpl = fetch }) {
  let body;
  try {
    body = encrypt(JSON.stringify(payload), subscription);
  } catch (e) {
    // A subscription whose keys cannot be used will never be usable. Treated
    // as gone so it is cleaned away, rather than failing on every alert.
    return { outcome: 'gone', status: 0, detail: e.message };
  }

  let res;
  try {
    res = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidHeader({
          endpoint: subscription.endpoint, publicKey: keys.publicKey, privateKey: keys.privateKey, subject,
        }),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(24 * 3600),
        Urgency: 'high',
      },
      body,
    });
  } catch (e) {
    return { outcome: 'failed', status: 0, detail: e.message };
  }

  const outcome = outcomeOf(res.status);
  const detail = outcome === 'sent' ? undefined : await res.text().catch(() => '');
  return { outcome, status: res.status, detail: detail ? detail.slice(0, 200) : undefined };
}
