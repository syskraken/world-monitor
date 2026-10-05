'use strict';
/*
 * Event history — read side.
 *
 *   GET /api/events?since=<ms>[&limit=]   → events with time >= since, newest first
 *                                           (powers "what's new since I last looked")
 *   GET /api/events?view=trends[&hours=24] → timeline buckets + top kinds/countries
 *
 * Degrades gracefully: when storage isn't configured, returns { configured:false }
 * so the client can simply hide the history/trend features.
 */
const store = require('../lib/store');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!store.configured()) return res.status(200).json({ configured: false, events: [] });

  const q = req.query || {};
  const now = Date.now();

  try {
    if (q.view === 'trends') {
      const hours = Math.min(Math.max(parseInt(q.hours, 10) || 24, 1), 168);
      const since = now - hours * 3600e3;
      const events = await store.eventsSince(since, 2000);

      const layers = { quakes: 0, events: 0, alerts: 0 };
      const kinds = new Map();
      const countries = new Map();
      let maxMag = 0, severe = 0;
      const bucketMs = 3600e3;
      const nBuckets = hours;
      const buckets = Array.from({ length: nBuckets }, (_, i) => ({
        t: now - (nBuckets - 1 - i) * bucketMs, count: 0,
      }));

      for (const e of events) {
        layers[e.layer] = (layers[e.layer] || 0) + 1;
        kinds.set(e.kind, (kinds.get(e.kind) || 0) + 1);
        if (e.country) countries.set(e.country, (countries.get(e.country) || 0) + 1);
        if (e.mag && e.mag > maxMag) maxMag = e.mag;
        if (e.sev === 'extreme' || e.sev === 'high') severe++;
        const idx = Math.floor((e.time - since) / bucketMs);
        if (idx >= 0 && idx < nBuckets) buckets[idx].count++;
      }
      const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, count }));

      return res.status(200).json({
        configured: true, now, hours,
        total: events.length, layers, maxMag, severe,
        lastHour: events.filter((e) => e.time >= now - 3600e3).length,
        buckets, topKinds: top(kinds), topCountries: top(countries),
      });
    }

    const since = parseInt(q.since, 10) || 0;
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 400, 1), 1000);
    const events = await store.eventsSince(since, limit);
    return res.status(200).json({ configured: true, now, count: events.length, events });
  } catch (e) {
    return res.status(500).json({ configured: true, error: e.message, events: [] });
  }
};
