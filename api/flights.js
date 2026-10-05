'use strict';
/*
 * Live aircraft positions → compact JSON.
 *
 *   GET /api/flights?lat=14.6&lon=121&dist=180   → regional, high detail, fresh
 *   GET /api/flights?global=1                    → whole planet, coarse, slow refresh
 *
 * Two upstreams, because neither alone does the job:
 *
 *   • adsb.fi / adsb.lol — community ADS-B feeds. Free, no key, no daily quota,
 *     and they carry registration + aircraft type. Capped at a 250 nm radius,
 *     so they only serve the "zoomed in" case.
 *   • OpenSky — the only keyless source with true global coverage, but anonymous
 *     access is metered at 400 credits/day (a global query costs 4). Cached hard
 *     and used only when the viewport is too wide for a radius query.
 *
 * Both are normalised to SI (metres, m/s, degrees true) and packed as arrays
 * rather than objects — a global snapshot is ~13k aircraft and the key names
 * would otherwise dominate the payload.
 *
 *   [ id, callsign, lat, lon, altM, spdMs, trackDeg, vertRateMs, type, reg, desc, ageSec, country ]
 *
 * `type`/`reg`/`desc` come only from the ADS-B feeds; `country` only from OpenSky.
 * They are kept in separate slots so the browser never shows one as the other.
 *
 * `ageSec` is how stale that position already was when the snapshot was taken;
 * the browser dead-reckons each aircraft forward from `ts - ageSec` so planes
 * move continuously between refreshes instead of teleporting.
 */

const FT = 0.3048;              // feet → metres
const KT = 0.514444;            // knots → m/s
const FPM = FT / 60;            // feet/min → m/s

const LOCAL_TTL = 8 * 1000;         // community feeds update ~1 Hz; 8s is polite and still live
const GLOBAL_TTL = 240 * 1000;      // 4 min ⇒ ~15 upstream calls/h ⇒ ~60 of 400 credits/h
const GLOBAL_CAP = 4000;            // spread-sampled; more dots than this are indistinguishable
const LOCAL_CAP = 1200;

const cache = new Map();            // key → { at, body }

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const r0 = (v) => (v == null ? null : Math.round(v));

// Keep global coverage when trimming: sample across the list rather than truncating.
function spread(list, cap) {
  if (list.length <= cap) return list;
  const step = list.length / cap, out = [];
  for (let i = 0; i < cap; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

/* ---- community ADS-B feeds (regional, detailed) ----------------------- */
const LOCAL_SOURCES = [
  { name: 'adsb.fi', url: (la, lo, d) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${d}` },
  { name: 'adsb.lol', url: (la, lo, d) => `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/${d}` },
];

function packLocal(a, nowSec) {
  const lat = num(a.lat), lon = num(a.lon);
  if (lat == null || lon == null) return null;
  const onGround = a.alt_baro === 'ground';
  // alt_geom (GPS) is the true height; alt_baro is the pressure altitude pilots fly.
  const altFt = num(a.alt_geom) != null ? num(a.alt_geom) : num(a.alt_baro);
  const rateFpm = num(a.geom_rate) != null ? num(a.geom_rate) : num(a.baro_rate);
  return [
    String(a.hex || '').trim(),
    String(a.flight || '').trim(),
    r3(lat), r3(lon),
    onGround ? 0 : r0(altFt == null ? null : altFt * FT),
    r0(num(a.gs) == null ? null : num(a.gs) * KT),
    r0(num(a.track) != null ? num(a.track) : num(a.true_heading)),
    rateFpm == null ? 0 : Math.round(rateFpm * FPM * 10) / 10,
    String(a.t || '').trim(),
    String(a.r || '').trim(),
    String(a.desc || '').trim(),
    Math.max(0, Math.round(num(a.seen_pos) || 0)),
    '',
  ];
}

async function fetchLocal(lat, lon, dist) {
  let lastErr = 'no source';
  for (const src of LOCAL_SOURCES) {
    try {
      const r = await fetch(src.url(lat, lon, dist), {
        headers: { 'User-Agent': 'worldwatch/1.0 (open-source situation monitor)', Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) { lastErr = src.name + ' HTTP ' + r.status; continue; }
      const j = await r.json();
      const list = j.ac || j.aircraft || [];
      const nowSec = Math.floor(Date.now() / 1000);
      const out = [];
      for (const a of list) { const p = packLocal(a, nowSec); if (p) out.push(p); }
      return { src: src.name, flights: spread(out, LOCAL_CAP), total: out.length };
    } catch (e) { lastErr = src.name + ': ' + e.message; }
  }
  throw new Error(lastErr);
}

/* ---- OpenSky (global, coarse) ----------------------------------------- */
// state vector: 0 icao24, 1 callsign, 2 country, 3 time_position, 5 lon, 6 lat,
//               7 baro_alt, 8 on_ground, 9 velocity, 10 true_track, 11 vert_rate, 13 geo_alt
async function fetchGlobal() {
  const r = await fetch('https://opensky-network.org/api/states/all', {
    headers: { 'User-Agent': 'worldwatch/1.0 (open-source situation monitor)', Accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });
  if (r.status === 429) throw new Error('quota');
  if (!r.ok) throw new Error('opensky HTTP ' + r.status);
  const j = await r.json();
  const snap = num(j.time) || Math.floor(Date.now() / 1000);
  const out = [];
  for (const s of j.states || []) {
    const lat = num(s[6]), lon = num(s[5]);
    if (lat == null || lon == null) continue;
    if (s[8]) continue;                                   // parked/taxiing: not "in the sky"
    const alt = num(s[13]) != null ? num(s[13]) : num(s[7]);
    out.push([
      String(s[0] || ''),
      String(s[1] || '').trim(),
      r3(lat), r3(lon),
      r0(alt),
      r0(num(s[9])),
      r0(num(s[10])),
      Math.round((num(s[11]) || 0) * 10) / 10,
      '', '', '',
      Math.max(0, snap - (num(s[3]) || snap)),
      String(s[2] || ''),
    ]);
  }
  return { src: 'opensky', flights: spread(out, GLOBAL_CAP), total: out.length };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const isGlobal = q.global === '1' || q.global === 'true';

  let key, ttl, run;
  if (isGlobal) {
    key = 'global';
    ttl = GLOBAL_TTL;
    run = fetchGlobal;
  } else {
    const lat = Math.max(-90, Math.min(90, parseFloat(q.lat)));
    const lon = Math.max(-180, Math.min(180, parseFloat(q.lon)));
    const dist = Math.max(10, Math.min(250, Math.round(parseFloat(q.dist) || 150)));
    if (!isFinite(lat) || !isFinite(lon)) {
      return res.status(400).json({ error: 'lat and lon required', flights: [] });
    }
    // Round the centre so small pans reuse one cache entry instead of re-fetching.
    const kLat = Math.round(lat * 2) / 2, kLon = Math.round(lon * 2) / 2;
    key = `${kLat},${kLon},${dist}`;
    ttl = LOCAL_TTL;
    run = () => fetchLocal(kLat, kLon, dist);
  }

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) {
    return res.status(200).json({ ...hit.body, cached: true, age: Math.round((Date.now() - hit.at) / 1000) });
  }

  try {
    const body = await run();
    body.ts = Date.now();
    body.mode = isGlobal ? 'global' : 'local';
    body.count = body.flights.length;
    cache.set(key, { at: Date.now(), body });
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    return res.status(200).json({ ...body, cached: false, age: 0 });
  } catch (e) {
    // Serve stale rather than blanking the map — dead reckoning keeps it sensible.
    if (hit) return res.status(200).json({ ...hit.body, cached: 'stale', age: Math.round((Date.now() - hit.at) / 1000) });
    const quota = e.message === 'quota';
    return res.status(200).json({
      error: quota ? 'Global flight quota reached — zoom in for live coverage' : e.message,
      quota, flights: [], count: 0, ts: Date.now(), mode: isGlobal ? 'global' : 'local',
    });
  }
};
