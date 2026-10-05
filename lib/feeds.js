'use strict';
/*
 * Server-side hazard ingestion. Pulls the same three sources the browser uses
 * and normalises them into a single event shape. Runs in a Node serverless
 * function, so there is no DOMParser — GDACS RSS is parsed with regex.
 *
 * Normalised event:
 *   { id, source, layer, kind, title, place, country, sev,
 *     mag?, cat?, eventtype?, lat, lon, time (epoch ms), url }
 */

const OUTBOUND_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.8',
};

async function getText(url) {
  const r = await fetch(url, { headers: OUTBOUND_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.text();
}
async function getJson(url) {
  return JSON.parse(await getText(url));
}

function sevFromMag(m) { return m >= 6 ? 'extreme' : m >= 5 ? 'high' : m >= 4 ? 'moderate' : 'low'; }

/* -------- USGS earthquakes (GeoJSON) ------------------------------------ */
// all_day gives a full 24h of history on the very first poll and is resilient
// to gaps between runs; dedup (HSETNX) makes the repeated re-scan almost free.
// We keep M2.5+ to match the map and keep storage sane.
async function loadUSGS() {
  const data = await getJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson');
  const out = [];
  for (const f of data.features || []) {
    const p = f.properties, c = f.geometry && f.geometry.coordinates;
    if (!c || !p) continue;
    const mag = Math.round((p.mag || 0) * 10) / 10;
    if (mag < 2.5) continue;
    out.push({
      id: 'q' + p.code,
      source: 'usgs', layer: 'quakes', kind: 'Earthquake',
      title: p.place || ('M' + mag + ' earthquake'),
      place: p.place || '', country: countryFromPlace(p.place),
      sev: p.alert ? alertToSev(p.alert) : sevFromMag(mag),
      mag, lat: c[1], lon: c[0], time: p.time || Date.now(), url: p.url,
    });
  }
  return out;
}
function alertToSev(a) { return a === 'red' ? 'extreme' : a === 'orange' ? 'high' : a === 'yellow' ? 'moderate' : 'low'; }
// USGS place strings usually end with the region/country, e.g. "80km N of (place), Japan".
function countryFromPlace(place) {
  if (!place) return '';
  const m = /,\s*([^,]+)\s*$/.exec(place);
  return m ? m[1].trim() : '';
}

/* -------- NASA EONET natural events (JSON) ------------------------------ */
async function loadEONET() {
  const data = await getJson('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=120');
  const out = [];
  for (const ev of data.events || []) {
    const geoms = ev.geometry || [];
    if (!geoms.length) continue;
    const g = geoms[geoms.length - 1];
    let lon, lat;
    if (g.type === 'Point') { [lon, lat] = g.coordinates; }
    else if (Array.isArray(g.coordinates)) { const r = g.coordinates[0]; const pt = Array.isArray(r[0]) ? r[0] : r; [lon, lat] = pt; }
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const cat = (ev.categories && ev.categories[0]) || {};
    out.push({
      id: 'e_' + ev.id,
      source: 'eonet', layer: 'events', kind: cat.title || 'Event',
      title: ev.title, place: '', country: '',   // EONET has no place name — only coordinates
      sev: 'moderate', lat, lon,
      time: Date.parse(g.date) || Date.now(),
      url: (ev.sources && ev.sources[0] && ev.sources[0].url) || ev.link || '',
    });
  }
  return out;
}

/* -------- GDACS disaster alerts (RSS/XML via regex) --------------------- */
const GDACS_TYPE = {
  EQ: 'Earthquake', TC: 'Tropical Cyclone', FL: 'Flood', VO: 'Volcano',
  DR: 'Drought', WF: 'Wildfire', TS: 'Tsunami',
};
function tag(block, name) {
  // handles <name>..</name> and <name .../> ; name may contain a ':' or '.'
  const re = new RegExp('<' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^>]*>([\\s\\S]*?)</' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '>', 'i');
  const m = re.exec(block);
  if (!m) return '';
  return decodeEntities(m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim());
}
function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function catFromText(s) {
  const m = /category\s*[:\-]?\s*(\d)/i.exec(s || '');
  return m ? Number(m[1]) : 0;
}

async function loadGDACS() {
  const xml = await getText('https://www.gdacs.org/xml/rss.xml');
  const items = xml.split(/<item>/i).slice(1).map((s) => s.split(/<\/item>/i)[0]);
  const out = [];
  for (const it of items) {
    const level = tag(it, 'gdacs:alertlevel') || 'Green';
    if (level === 'Green') continue; // only surface Orange/Red as stored alerts
    const et = tag(it, 'gdacs:eventtype');
    let lat = parseFloat(tag(it, 'geo:lat'));
    let lon = parseFloat(tag(it, 'geo:long'));
    if (!isFinite(lat)) {
      const pt = tag(it, 'georss:point').split(/\s+/);
      lat = parseFloat(pt[0]); lon = parseFloat(pt[1]);
    }
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const eventid = tag(it, 'gdacs:eventid');
    const title = tag(it, 'title');
    const severity = tag(it, 'gdacs:severity');
    out.push({
      id: 'g_' + (et || 'X') + '_' + (eventid || Math.abs(hash(title))),
      source: 'gdacs', layer: 'alerts', eventtype: et,
      kind: GDACS_TYPE[et] || 'Hazard', title,
      place: tag(it, 'gdacs:country'), country: tag(it, 'gdacs:country'),
      sev: level === 'Red' ? 'extreme' : 'high',
      cat: et === 'TC' ? (catFromText(severity) || catFromText(title)) : undefined,
      lat, lon, time: Date.parse(tag(it, 'pubDate')) || Date.now(),
      url: tag(it, 'link'),
    });
  }
  return out;
}
function hash(s) { let h = 0; for (let i = 0; i < (s || '').length; i++) { h = (h << 5) - h + s.charCodeAt(i) | 0; } return h; }

/* -------- combined ------------------------------------------------------ */
async function fetchAllEvents() {
  const settled = await Promise.allSettled([loadUSGS(), loadEONET(), loadGDACS()]);
  const events = [];
  const sources = { usgs: false, eonet: false, gdacs: false };
  const names = ['usgs', 'eonet', 'gdacs'];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') { sources[names[i]] = true; events.push(...r.value); }
  });
  return { events, sources };
}

module.exports = { fetchAllEvents, loadUSGS, loadEONET, loadGDACS };
