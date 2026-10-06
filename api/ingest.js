'use strict';
/*
 * Background ingestion — the heart of the monitor. A scheduler (Vercel Cron on
 * Pro, or a free external pinger such as cron-job.org on Hobby) hits this every
 * few minutes. It polls the feeds, stores only brand-new events, evaluates each
 * one against every subscriber's rules, and sends Web Push for matches.
 *
 *   GET /api/ingest?key=<INGEST_SECRET>
 *
 * Protected by INGEST_SECRET so it can't be triggered (or abused) by randoms.
 */
const store = require('../lib/store');
const { fetchAllEvents } = require('../lib/feeds');
const rules = require('../lib/rules');
const push = require('../lib/push');

// Only alert on genuinely recent events. This stops an alert storm on the very
// first run (which backfills ~24h of history) and prevents re-alerting on
// anything that predates the subscriber.
const ALERT_WINDOW_MS = 90 * 60 * 1000;
// 60 days: event pages and 30-day country pages are built from this history.
const RETAIN_MS = 60 * 24 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  const secret = process.env.INGEST_SECRET;
  const key = (req.query && req.query.key) || req.headers['x-ingest-key'];
  if (secret && key !== secret) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!store.configured()) return res.status(503).json({ ok: false, error: 'storage not configured (set KV/Upstash env vars)' });

  const started = Date.now();
  let events = [], sources = {};
  try {
    ({ events, sources } = await fetchAllEvents());
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'feeds: ' + e.message });
  }

  let fresh = [];
  try {
    fresh = await store.addEvents(events);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'store: ' + e.message });
  }
  store.pruneOlderThan(Date.now() - RETAIN_MS).catch(() => {});

  // ---- alerting ----
  let matched = 0, pushed = 0, dropped = 0;
  const recent = fresh.filter((e) => e.time >= Date.now() - ALERT_WINDOW_MS);
  if (push.haveKeys() && recent.length) {
    const subs = await store.allSubs();
    for (const sub of subs) {
      if (!sub.endpoint || !sub.keys) continue;
      for (const ev of recent) {
        const reason = rules.matchEvent(ev, sub.rules);
        if (!reason) continue;
        matched++;
        try {
          const r = await push.sendPush({ endpoint: sub.endpoint, keys: sub.keys }, rules.buildPayload(ev, reason));
          if (r.gone) { await store.delSub(sub.id); dropped++; break; }
          pushed++;
        } catch { /* one bad endpoint shouldn't fail the run */ }
      }
    }
  }

  await Promise.all([
    store.setStat('lastRun', Date.now()),
    store.setStat('lastFresh', fresh.length),
  ]).catch(() => {});

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true, ms: Date.now() - started,
    feeds: sources, total: events.length, fresh: fresh.length,
    alerts: { matched, pushed, prunedSubs: dropped, pushEnabled: push.haveKeys() },
  });
};
