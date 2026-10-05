'use strict';
/*
 * Web Push, implemented natively on node:crypto — no `web-push` dependency.
 *
 *   - Payload encryption: RFC 8291 (Message Encryption) over the
 *     RFC 8188 "aes128gcm" content coding.
 *   - Auth: RFC 8292 VAPID (ES256 JWT).
 *
 * Env:
 *   VAPID_PUBLIC_KEY   base64url, uncompressed P-256 point (65 bytes)
 *   VAPID_PRIVATE_KEY  base64url, raw P-256 scalar `d` (32 bytes)
 *   VAPID_SUBJECT      mailto: or https: contact (defaults to a mailto)
 */
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

function haveKeys() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}
function vapidPublicKey() { return process.env.VAPID_PUBLIC_KEY || ''; }

/* -------- HKDF (RFC 5869), one HMAC block is enough (all L <= 32) -------- */
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function hkdf(salt, ikm, info, len) {
  const prk = hmac(salt, ikm);                              // extract
  const t = hmac(prk, Buffer.concat([info, Buffer.from([1])])); // expand (single block)
  return t.subarray(0, len);
}

/* -------- RFC 8291 payload encryption ----------------------------------- */
// `test` lets the self-test pin the salt + server keypair for determinism.
function encrypt(uaPublicB64, authSecretB64, payload, test) {
  const uaPublic = fromB64u(uaPublicB64);        // 65-byte browser public key
  const authSecret = fromB64u(authSecretB64);    // 16-byte auth secret
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');

  const salt = test ? test.salt : crypto.randomBytes(16);
  const ecdh = crypto.createECDH('prime256v1');
  if (test) ecdh.setPrivateKey(test.serverPrivate); else ecdh.generateKeys();
  const serverPublic = ecdh.getPublicKey();      // 65-byte uncompressed
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info"||0x00||ua||as, 32)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, serverPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // Single record: plaintext || 0x02 delimiter (last record), no extra padding.
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  // aes128gcm header: salt(16) | rs(uint32 BE) | idlen(1) | keyid(as public)
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([serverPublic.length]), serverPublic]);
  return Buffer.concat([header, body]);
}

/* -------- VAPID JWT (RFC 8292) ------------------------------------------ */
function vapidPrivateKeyObject() {
  const pub = fromB64u(process.env.VAPID_PUBLIC_KEY); // 0x04 | X(32) | Y(32)
  return crypto.createPrivateKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
      d: process.env.VAPID_PRIVATE_KEY,
    },
    format: 'jwk',
  });
}
function vapidHeaders(endpoint) {
  const aud = new URL(endpoint).origin;
  // RFC 8292: sub MUST be a mailto: or https: URI — coerce a bare email.
  let sub = process.env.VAPID_SUBJECT || 'mailto:alerts@world-monitor';
  if (!/^(https?|mailto):/i.test(sub)) sub = 'mailto:' + sub;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub,
  }));
  const signingInput = header + '.' + claims;
  const sig = crypto.sign('SHA256', Buffer.from(signingInput), {
    key: vapidPrivateKeyObject(),
    dsaEncoding: 'ieee-p1363', // raw r||s (64 bytes) — what JWS ES256 requires
  });
  const jwt = signingInput + '.' + b64u(sig);
  return {
    Authorization: 'vapid t=' + jwt + ', k=' + process.env.VAPID_PUBLIC_KEY,
  };
}

/* -------- send ---------------------------------------------------------- */
// subscription = { endpoint, keys:{ p256dh, auth } }
async function sendPush(subscription, payloadObj, opts = {}) {
  const endpoint = subscription.endpoint;
  const body = encrypt(
    subscription.keys.p256dh,
    subscription.keys.auth,
    typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj)
  );
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...vapidHeaders(endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttl || 86400),
      Urgency: opts.urgency || 'high',
    },
    body,
    signal: AbortSignal.timeout(12000),
  });
  // 404/410 => the subscription is dead and should be pruned by the caller.
  return { status: res.status, gone: res.status === 404 || res.status === 410, endpoint };
}

module.exports = { haveKeys, vapidPublicKey, sendPush, encrypt, _internal: { hkdf } };
