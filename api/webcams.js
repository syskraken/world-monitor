'use strict';
/*
 * Public traffic cameras → compact JSON.
 *
 *   GET /api/webcams                          → global sample (spread, capped)
 *   GET /api/webcams?bbox=w,s,e,n&limit=1500  → just what the viewport covers
 *
 * There is no global registry of traffic cameras: every road authority
 * publishes (or doesn't) on its own terms, and most of the US "511" systems sit
 * behind API keys. This pulls the authorities that publish openly and merges
 * them into one set. Adding another is a single entry in SOURCES.
 *
 * Only official government/road-authority feeds are used. Camera *locations*
 * barely change, so the merged index is cached for hours; the images themselves
 * are live and loaded straight from the authority by the browser.
 *
 *   [ id, lat, lon, name, imageUrl, sourceIndex, streamUrl ]
 *
 * streamUrl is an HLS playlist where the authority publishes genuine live video
 * (Caltrans does, for ~98% of its cameras); empty elsewhere, where the feed is a
 * periodically-refreshed still.
 */

let store = null;
try { store = require('../lib/store'); } catch { /* in-memory cache is enough */ }

const TTL = 6 * 60 * 60 * 1000;          // camera lists are near-static
const MERGE_TTL = 10 * 60 * 1000;        // re-merge often, so parts that were slow
                                         // last time get folded in soon after
const SHARED_KEY = 'wm:webcams:v1';
const DEFAULT_LIMIT = 1500;
const HARD_CAP = 6000;
const STREAM_PROBE_CONC = 40;
const UA = { 'User-Agent': 'worldwatch/1.0 (open-source situation monitor)', Accept: 'application/json,text/plain,*/*' };

let cache = { at: 0, body: null };
let inflight = null;
const partCache = new Map();             // key -> { at, rows }
const streamOk = new Map();              // playlist url -> reachable?
let validating = false;

// Caltrans advertises a streamingVideoURL for cameras whose stream does not
// actually exist — about one in eight 404s. Marking those as "live video" and
// then falling back to a still is worse than never promising video, so the
// advertised playlists are probed and the dead ones dropped. Too slow to block
// a request (~2 min for 1800), so it runs in the background and the verdicts
// are remembered; the index self-corrects within a couple of minutes of boot.
async function validateStreams(body) {
  if (validating) return;
  validating = true;
  const todo = body.cams.filter((c) => c[6] && !streamOk.has(c[6]));
  let i = 0;
  await Promise.all([...Array(STREAM_PROBE_CONC)].map(async () => {
    while (i < todo.length) {
      const c = todo[i++];
      let live = false;
      try {
        const r = await fetch(c[6], { headers: UA, signal: AbortSignal.timeout(6000) });
        live = r.ok;
        await r.arrayBuffer().catch(() => {});
      } catch { live = false; }
      streamOk.set(c[6], live);
    }
  }));
  let dropped = 0;
  for (const c of body.cams) if (c[6] && streamOk.get(c[6]) === false) { c[6] = ''; dropped++; }
  body.streamsVerified = true;
  body.streamsDropped = dropped;
  writeShared(body);
  validating = false;
}

// Each upstream (and each Caltrans district) is cached on its own. Caltrans
// publishes 12 district files and the big ones — LA, San Bernardino — take
// 10s+, so a single timeout would otherwise throw away everything fetched
// alongside it. Stale rows always beat none.
async function part(key, loader) {
  const hit = partCache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.rows;
  try {
    const rows = await loader();
    partCache.set(key, { at: Date.now(), rows });
    return rows;
  } catch (e) {
    if (hit) return hit.rows;
    throw e;
  }
}

const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };
const r5 = (v) => Math.round(v * 100000) / 100000;

async function getJson(url, ms) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms || 7000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ---- one entry per authority ------------------------------------------ */
const SOURCES = [
  {
    name: 'Caltrans', region: 'California, USA', url: 'https://dot.ca.gov',
    // 12 districts, each its own file; partial failures are fine.
    async load() {
      const districts = await Promise.allSettled([...Array(12)].map((_, i) => {
        const d = i + 1;
        return part('caltrans-d' + d, async () => {
          const j = await getJson(`https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${String(d).padStart(2, '0')}.json`, 14000);
          const rows = [];
          for (const row of j.data || []) {
            const c = row.cctv;
            if (!c || String(c.inService) === 'false') continue;
            const lat = num(c.location && c.location.latitude), lon = num(c.location && c.location.longitude);
            const img = c.imageData && c.imageData.static && c.imageData.static.currentImageURL;
            if (lat == null || lon == null || !img || (!lat && !lon)) continue;
            const vid = c.imageData.streamingVideoURL || '';
            rows.push([lat, lon, (c.location.locationName || '').trim() || c.location.nearbyPlace || 'Caltrans camera', img, vid]);
          }
          return rows;
        });
      }));
      const out = [];
      let got = 0;
      for (const d of districts) if (d.status === 'fulfilled') { out.push(...d.value); got++; }
      if (!out.length) throw new Error('all districts unavailable');
      out.districts = got;
      return out;
    },
  },
  {
    name: 'DriveBC', region: 'British Columbia, Canada', url: 'https://www.drivebc.ca',
    load: () => part('drivebc', async () => {
      const list = await getJson('https://www.drivebc.ca/api/webcams', 12000);
      const out = [];
      for (const c of list) {
        const g = c.location && c.location.coordinates;
        if (!g || c.is_on === false) continue;
        const img = c.links && c.links.imageDisplay;
        if (!img) continue;
        out.push([num(g[1]), num(g[0]), c.name || 'DriveBC camera',
          img.startsWith('http') ? img : 'https://www.drivebc.ca' + img]);
      }
      return out;
    }),
  },
  {
    name: 'Transport Department', region: 'Hong Kong', url: 'https://data.gov.hk',
    load: () => part('hongkong', async () => {
      // Tab-separated, UTF-16LE.
      const r = await fetch('https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.csv',
        { headers: UA, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = Buffer.from(await r.arrayBuffer()).toString('utf16le');
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const head = lines[0].replace(/^﻿+/, '').split('\t').map((s) => s.trim().toLowerCase());
      const iLat = head.indexOf('latitude'), iLon = head.indexOf('longitude');
      const iDesc = head.indexOf('description'), iUrl = head.indexOf('url');
      const out = [];
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split('\t');
        const lat = num(c[iLat]), lon = num(c[iLon]);
        if (lat == null || lon == null || !c[iUrl]) continue;
        out.push([lat, lon, (c[iDesc] || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim() || 'HK camera', c[iUrl].trim()]);
      }
      return out;
    }),
  },
  {
    name: 'Ontario 511', region: 'Ontario, Canada', url: 'https://511on.ca',
    load: () => part('ontario', async () => {
      const list = await getJson('https://511on.ca/api/v2/get/cameras?format=json', 12000);
      const out = [];
      for (const c of list) {
        const lat = num(c.Latitude), lon = num(c.Longitude);
        const view = (c.Views || []).find((v) => v && v.Url);
        if (lat == null || lon == null || !view) continue;
        out.push([lat, lon, c.Location || c.Roadway || 'Ontario camera', view.Url]);
      }
      return out;
    }),
  },
  {
    name: 'Fintraffic', region: 'Finland', url: 'https://www.digitraffic.fi',
    load: () => part('finland', async () => {
      const fc = await getJson('https://tie.digitraffic.fi/api/weathercam/v1/stations', 12000);
      const out = [];
      for (const f of fc.features || []) {
        const g = f.geometry && f.geometry.coordinates;
        const p = f.properties || {};
        const preset = (p.presets || []).find((x) => x && x.id);
        if (!g || !preset) continue;
        out.push([num(g[1]), num(g[0]), (p.name || p.id || '').replace(/_/g, ' '),
          'https://weathercam.digitraffic.fi/' + preset.id + '.jpg']);
      }
      return out;
    }),
  },
  {
    name: 'LTA', region: 'Singapore', url: 'https://data.gov.sg',
    load: async () => {
      const j = await getJson('https://api.data.gov.sg/v1/transport/traffic-images', 9000);
      const cams = (j.items && j.items[0] && j.items[0].cameras) || [];
      return cams
        .filter((c) => c.location && c.image)
        .map((c) => [num(c.location.latitude), num(c.location.longitude), 'Camera ' + c.camera_id, c.image]);
    },
  },
];

/* ---- optional: US "511" systems, one per free API key ------------------- */
// All run the same platform, so one loader covers every state. Each needs its
// own free key from that state's developer page; set the env var and the source
// appears. These publish stills only — the loader still picks up an HLS URL
// automatically if a deployment ever serves one.
const FIVE11 = [
  ['WM_511_NY', '511ny.org', '511 New York', 'New York, USA'],
  ['WM_511_PA', 'www.511pa.com', '511 Pennsylvania', 'Pennsylvania, USA'],
  ['WM_511_GA', '511ga.org', '511 Georgia', 'Georgia, USA'],
  ['WM_511_IA', '511ia.org', '511 Iowa', 'Iowa, USA'],
  ['WM_511_ID', '511.idaho.gov', '511 Idaho', 'Idaho, USA'],
  ['WM_511_VA', '511virginia.org', '511 Virginia', 'Virginia, USA'],
];
for (const [env, host, name, region] of FIVE11) {
  if (!process.env[env]) continue;
  SOURCES.push({
    name, region, url: 'https://' + host,
    load: () => part('511-' + host, async () => {
      const list = await getJson('https://' + host + '/api/v2/get/cameras?format=json&key='
        + encodeURIComponent(process.env[env]), 12000);
      const out = [];
      for (const c of list || []) {
        const lat = num(c.Latitude), lon = num(c.Longitude);
        const view = (c.Views || []).find((v) => v && v.Url && v.Status !== 'Disabled');
        if (lat == null || lon == null || !view) continue;
        const hls = /.m3u8/i.test(view.Url) ? view.Url : '';
        out.push([lat, lon, c.Location || c.Roadway || name, hls ? '' : view.Url, hls]);
      }
      return out;
    }),
  });
}

/* ---- optional: Windy's global webcam network (needs a free key) --------- */
// Everything above is a road authority, so coverage stops where authorities
// stop publishing — there is no open Philippine feed at all (MMDA's old public
// endpoint is dead and the current site is behind Cloudflare). Windy aggregates
// public webcams worldwide and fills those gaps.
//
// Unlike the others this is queried per viewport rather than indexed globally:
// the network is far too large to enumerate, and Windy's free tier is metered.
// Results are cached per rounded box. Windy serves stills (its live player is
// an iframe embed, not an HLS playlist), so these show as SNAPSHOT.
const WINDY_TTL = 10 * 60 * 1000;
const windyCache = new Map();

async function windyForBox(box) {
  const key = process.env.WM_WINDY_KEY;
  if (!key || !box) return null;
  const ck = [box.w, box.s, box.e, box.n].map((v) => v.toFixed(2)).join(',');
  const hit = windyCache.get(ck);
  if (hit && Date.now() - hit.at < WINDY_TTL) return hit.rows;
  // Windy takes the box as north,east,south,west.
  const url = 'https://api.windy.com/webcams/api/v3/webcams'
    + '?bbox=' + [box.n, box.e, box.s, box.w].join(',')
    + '&limit=50&include=images,location';
  try {
    const r = await fetch(url, {
      headers: { ...UA, 'x-windy-api-key': key },
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const rows = [];
    for (const w of j.webcams || []) {
      const loc = w.location || {};
      const lat = num(loc.latitude), lon = num(loc.longitude);
      const im = (w.images && w.images.current) || {};
      const img = im.preview || im.thumbnail || im.icon || '';
      if (lat == null || lon == null || !img) continue;
      const label = w.title || [loc.city, loc.country].filter(Boolean).join(', ') || 'Webcam';
      rows.push([lat, lon, label, img]);
    }
    windyCache.set(ck, { at: Date.now(), rows });
    if (windyCache.size > 60) windyCache.delete(windyCache.keys().next().value);
    return rows;
  } catch (e) {
    return hit ? hit.rows : [];      // never let an optional source break the layer
  }
}

/* ---- merge + cache ----------------------------------------------------- */
function spread(list, cap) {
  if (list.length <= cap) return list;
  const step = list.length / cap, out = [];
  for (let i = 0; i < cap; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

async function buildIndex() {
  const settled = await Promise.allSettled(SOURCES.map((s) => s.load()));
  const cams = [], sources = [];
  settled.forEach((res, i) => {
    const s = SOURCES[i];
    const rows = res.status === 'fulfilled' ? res.value : [];
    sources.push({ name: s.name, region: s.region, url: s.url, count: rows.length,
      parts: rows.districts,
      error: res.status === 'rejected' ? String(res.reason && res.reason.message || res.reason).slice(0, 80) : undefined });
    let n = 0;
    for (const [lat, lon, name, img, stream] of rows) {
      if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const vid = stream && streamOk.get(stream) !== false ? stream : '';
      cams.push([i + '-' + n++, r5(lat), r5(lon), String(name).slice(0, 70), img, i, vid]);
    }
  });
  return { cams, sources, total: cams.length, built: Date.now() };
}

function writeShared(body) {
  if (!store || !store.configured()) return;
  store.cmd(['SET', SHARED_KEY, JSON.stringify(body), 'EX', Math.round(TTL / 1000)]).catch(() => {});
}
async function getIndex() {
  if (cache.body && Date.now() - cache.at < MERGE_TTL) return cache.body;
  if (store && store.configured()) {
    try {
      const v = await store.cmd(['GET', SHARED_KEY]);
      if (v) {
        const body = JSON.parse(v);
        if (Date.now() - (body.built || 0) < MERGE_TTL) { cache = { at: Date.now(), body }; return body; }
      }
    } catch { /* fall through to a live build */ }
  }
  if (!inflight) {
    inflight = buildIndex().then((body) => {
      cache = { at: Date.now(), body };
      writeShared(body);
      // best-effort, non-blocking: the first caller gets the index immediately
      validateStreams(body).catch(() => { validating = false; });
      inflight = null;
      return body;
    }).catch((e) => { inflight = null; throw e; });
  }
  return inflight;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  let body;
  try {
    body = await getIndex();
  } catch (e) {
    return res.status(200).json({ error: e.message, cams: [], sources: [], total: 0 });
  }

  const limit = Math.min(Math.max(parseInt(q.limit, 10) || DEFAULT_LIMIT, 50), HARD_CAP);
  let list = body.cams;
  let inBox = null, box = null;

  if (q.bbox) {
    const p = String(q.bbox).split(',').map(Number);
    if (p.length === 4 && p.every(isFinite)) {
      const [w, s, e, n] = p;
      box = { w, s, e, n };
      // A box may straddle the antimeridian, in which case west > east.
      const wrap = w > e;
      list = list.filter((c) => c[1] >= s && c[1] <= n && (wrap ? (c[2] >= w || c[2] <= e) : (c[2] >= w && c[2] <= e)));
      inBox = list.length;
    }
  }

  const sliced = spread(list, limit);
  let sources = body.sources;

  // Windy fills in everywhere no road authority publishes — the Philippines
  // among them. It is queried for the viewport rather than indexed globally,
  // and only when a key is configured.
  const windy = await windyForBox(box);
  if (windy && windy.length) {
    const si = sources.length;
    sources = sources.concat([{ name: 'Windy', region: 'Worldwide', url: 'https://www.windy.com/webcams', count: windy.length }]);
    windy.forEach((rw, k) => sliced.push(['w-' + k, r5(rw[0]), r5(rw[1]), String(rw[2]).slice(0, 70), rw[3], si, '']));
  }

  res.status(200).json({
    cams: sliced,
    count: sliced.length,
    inBox: inBox == null ? undefined : inBox,
    total: body.total,
    sources,
    built: body.built,
    streamsVerified: !!body.streamsVerified,
    windy: !!process.env.WM_WINDY_KEY,
  });
};
