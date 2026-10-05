'use strict';
/*
 * Push subscription + alert-rule management.
 *
 *   GET    /api/subscribe                  → { enabled, publicKey }  (client bootstrap)
 *   POST   /api/subscribe                  → upsert { subscription, rules }
 *   POST   /api/subscribe  {action:'test'} → send a one-off test notification
 *   DELETE /api/subscribe  {endpoint}      → remove subscription
 */
const crypto = require('crypto');
const store = require('../lib/store');
const push = require('../lib/push');

const subId = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 24);

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { return {}; } }
  return b;
}
function validSub(s) {
  return s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint)
    && s.keys && s.keys.p256dh && s.keys.auth;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const enabled = push.haveKeys() && store.configured();

  if (req.method === 'GET') {
    return res.status(200).json({ enabled, publicKey: push.vapidPublicKey() });
  }
  if (!enabled) return res.status(503).json({ ok: false, error: 'push not configured on server' });

  if (req.method === 'DELETE') {
    const body = readBody(req);
    const endpoint = body.endpoint || (req.query && req.query.endpoint);
    if (!endpoint) return res.status(400).json({ ok: false, error: 'endpoint required' });
    await store.delSub(subId(endpoint));
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'POST') {
    const body = readBody(req);
    const sub = body.subscription;
    if (!validSub(sub)) return res.status(400).json({ ok: false, error: 'invalid subscription' });

    if (body.action === 'test') {
      try {
        const r = await push.sendPush(
          { endpoint: sub.endpoint, keys: sub.keys },
          {
            title: 'World Monitor — alerts armed',
            body: 'Test notification. You will be alerted like this even with the tab closed.',
            tag: 'wm-test', url: '/',
          }
        );
        if (r.gone) await store.delSub(subId(sub.endpoint));
        return res.status(200).json({ ok: !r.gone, status: r.status });
      } catch (e) {
        return res.status(502).json({ ok: false, error: e.message });
      }
    }

    const rules = Array.isArray(body.rules) ? body.rules : [];
    await store.putSub(subId(sub.endpoint), {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      rules,
      ua: (req.headers['user-agent'] || '').slice(0, 160),
      updatedAt: Date.now(),
    });
    return res.status(200).json({ ok: true, id: subId(sub.endpoint), rules: rules.length });
  }

  res.status(405).json({ ok: false, error: 'method not allowed' });
};
