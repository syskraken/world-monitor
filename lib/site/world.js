'use strict';
/*
 * Server-side geography: country polygons (from world-data.js), point-in-country
 * lookup, free-text → country fallback, and a dependency-free SVG map renderer.
 */
const fs = require('fs');
const path = require('path');

// Display-name overrides: the polygon dataset uses some long / dated names.
const DISPLAY = {
  USA: 'United States', COG: 'Republic of the Congo', COD: 'DR Congo',
  TZA: 'Tanzania', SRB: 'Serbia', SWZ: 'Eswatini', MKD: 'North Macedonia',
  BHS: 'The Bahamas', TLS: 'Timor-Leste', CZE: 'Czechia', TUR: 'Turkey',
};
const SKIP = new Set(['ATA', 'ATF']); // no useful country pages

// Extra text → ISO3 for the free-text fallback (offshore events, USGS place suffixes).
const ALIAS = {
  'united states': 'USA', usa: 'USA', 'u.s.': 'USA', us: 'USA', america: 'USA',
  uk: 'GBR', england: 'GBR', scotland: 'GBR', 'great britain': 'GBR',
  'south korea': 'KOR', 'north korea': 'PRK', 'dr congo': 'COD', 'drc': 'COD',
  tanzania: 'TZA', turkiye: 'TUR', 'türkiye': 'TUR', burma: 'MMR', 'east timor': 'TLS',
  'timor-leste': 'TLS', 'czechia': 'CZE', 'ivory coast': 'CIV', "cote d'ivoire": 'CIV',
  eswatini: 'SWZ', 'north macedonia': 'MKD', serbia: 'SRB', bahamas: 'BHS', russia: 'RUS',
  'russian federation': 'RUS', 'hong kong': 'CHN', macau: 'CHN',
};
const US_STATES = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'florida', 'georgia (state)', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
  'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska',
  'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas',
  'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming'];
const US_ABBR = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
  'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY']);

function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function ringBBox(ring) {
  let a = 180, b = 90, c = -180, d = -90;
  for (const p of ring) {
    if (p[0] < a) a = p[0]; if (p[0] > c) c = p[0];
    if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1];
  }
  return [a, b, c, d];
}
function inRing(x, y, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) ins = !ins;
  }
  return ins;
}

let W = null;
function load() {
  if (W) return W;
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'world-data.js'), 'utf8');
  const fc = new Function(src + '\n;return WORLD_GEOJSON;')();
  const list = [];
  const used = new Set();
  for (const f of fc.features) {
    const iso = String(f.id || '');
    if (SKIP.has(iso)) continue;
    const raw = f.properties.name;
    const name = DISPLAY[iso] || raw;
    let slug = slugify(name);
    if (used.has(slug)) continue; // dataset has two '-99' territories; first wins on dupes
    used.add(slug);
    const g = f.geometry;
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((rings) => ({ rings, bbox: ringBBox(rings[0]) }));
    let minx = 180, miny = 90, maxx = -180, maxy = -90;
    const area = (p) => (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]);
    const maxA = Math.max(...polys.map(area));
    for (const p of polys) {
      if (area(p) < maxA * 0.08) continue; // ignore distant islands/territories when framing
      minx = Math.min(minx, p.bbox[0]); miny = Math.min(miny, p.bbox[1]);
      maxx = Math.max(maxx, p.bbox[2]); maxy = Math.max(maxy, p.bbox[3]);
    }
    list.push({ iso, name, slug, polys, bbox: [minx, miny, maxx, maxy] });
  }
  const bySlug = new Map(list.map((c) => [c.slug, c]));
  const byName = new Map();
  for (const c of list) { byName.set(c.name.toLowerCase(), c); byName.set(slugify(c.name).replace(/-/g, ' '), c); }
  const byIso = new Map(list.map((c) => [c.iso, c]));
  W = { list, bySlug, byName, byIso };
  return W;
}

function countryForPoint(lon, lat) {
  if (!isFinite(lon) || !isFinite(lat)) return null;
  for (const c of load().list) {
    for (const p of c.polys) {
      const b = p.bbox;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (!inRing(lon, lat, p.rings[0])) continue;
      let hole = false;
      for (let i = 1; i < p.rings.length; i++) if (inRing(lon, lat, p.rings[i])) { hole = true; break; }
      if (!hole) return c;
    }
  }
  return null;
}

function countryFromText(text) {
  if (!text) return null;
  const w = load();
  const t = String(text).trim();
  // USGS style: "12 km SW of Town, Region" → try the last comma-separated part, then the whole string.
  const parts = t.split(',').map((s) => s.trim()).filter(Boolean);
  const cands = [];
  if (parts.length) cands.push(parts[parts.length - 1]);
  cands.push(t);
  for (const raw of cands) {
    const k = raw.toLowerCase();
    if (US_ABBR.has(raw.toUpperCase()) && raw.length === 2) return w.byIso.get('USA') || null;
    if (US_STATES.includes(k)) return w.byIso.get('USA') || null;
    if (ALIAS[k]) return w.byIso.get(ALIAS[k]) || null;
    if (w.byName.has(k)) return w.byName.get(k);
  }
  // Whole-string contains a country name (≥5 chars to avoid false hits like "Oman" in "Romania").
  const low = t.toLowerCase();
  for (const c of w.list) {
    const n = c.name.toLowerCase();
    if (n.length >= 5 && new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(low)) return c;
  }
  return null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function neighbors(country, max = 8) {
  const w = load();
  const [a, b, c, d] = country.bbox;
  const pad = 1.5;
  return w.list.filter((o) => o !== country &&
    o.bbox[0] <= c + pad && o.bbox[2] >= a - pad && o.bbox[1] <= d + pad && o.bbox[3] >= b - pad).slice(0, max * 3);
}

/* -------- SVG map -------------------------------------------------------- */
const SEV_R = { low: 3.2, moderate: 4.2, high: 5.2, extreme: 6.4 };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/*
 * opts: { bbox:[minLon,minLat,maxLon,maxLat], highlight: slug, dots:[{lon,lat,sev,href,label}],
 *         pin:{lon,lat,sev,label}, label }
 * The view is padded and expanded to a fixed 9:5 aspect so every map is the same size.
 */
function renderMap(opts) {
  const w = load();
  const VW = 720, VH = 400, ASPECT = VW / VH;
  let [x0, y0, x1, y1] = opts.bbox;
  const midLat = (y0 + y1) / 2;
  const k = Math.max(0.25, Math.cos((midLat * Math.PI) / 180)); // equirectangular lon squeeze
  let spanX = Math.max((x1 - x0) * k, 2), spanY = Math.max(y1 - y0, 2);
  spanX *= 1.25; spanY *= 1.25;
  if (spanX / spanY < ASPECT) spanX = spanY * ASPECT; else spanY = spanX / ASPECT;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const lonSpan = spanX / k;
  const vx0 = cx - lonSpan / 2, vx1 = cx + lonSpan / 2, vy0 = cy - spanY / 2, vy1 = cy + spanY / 2;
  const px = (lon) => ((lon - vx0) / (vx1 - vx0)) * VW;
  const py = (lat) => ((vy1 - lat) / (vy1 - vy0)) * VH;

  let land = '', hl = '';
  for (const c of w.list) {
    const isHl = c.slug === opts.highlight;
    let d = '';
    for (const p of c.polys) {
      const b = p.bbox;
      if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) continue;
      for (const ring of p.rings) {
        let lx = -1e9, ly = -1e9, seg = '';
        for (let i = 0; i < ring.length; i++) {
          const x = px(ring[i][0]), y = py(ring[i][1]);
          if (i > 0 && i < ring.length - 1 && Math.abs(x - lx) < 0.7 && Math.abs(y - ly) < 0.7) continue;
          seg += (seg ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
          lx = x; ly = y;
        }
        if (seg) d += seg + 'Z';
      }
    }
    if (!d) continue;
    if (isHl) hl += '<path class="hl" d="' + d + '"><title>' + esc(c.name) + '</title></path>';
    else land += '<path d="' + d + '"/>';
  }

  let dots = '';
  const inView = (e) => e.lon >= vx0 && e.lon <= vx1 && e.lat >= vy0 && e.lat <= vy1;
  for (const e of (opts.dots || []).filter(inView).slice(0, 80)) {
    const circ = '<circle class="dot ' + esc(e.sev || 'low') + '" cx="' + px(e.lon).toFixed(1) + '" cy="' + py(e.lat).toFixed(1) +
      '" r="' + (SEV_R[e.sev] || 3.2) + '"><title>' + esc(e.label) + '</title></circle>';
    dots += e.href ? '<a href="' + esc(e.href) + '">' + circ + '</a>' : circ;
  }
  let pin = '';
  if (opts.pin && inView(opts.pin)) {
    const X = px(opts.pin.lon).toFixed(1), Y = py(opts.pin.lat).toFixed(1);
    pin = '<circle class="ring" cx="' + X + '" cy="' + Y + '" r="16"/><circle class="dot ' + esc(opts.pin.sev || 'low') +
      ' pin" cx="' + X + '" cy="' + Y + '" r="' + ((SEV_R[opts.pin.sev] || 4) + 1.5) + '"><title>' + esc(opts.pin.label) + '</title></circle>';
  }
  return '<figure class="map-fig"><svg class="map-svg" viewBox="0 0 ' + VW + ' ' + VH + '" role="img" aria-label="' + esc(opts.label || 'Map') +
    '" preserveAspectRatio="xMidYMid slice"><rect width="' + VW + '" height="' + VH + '" class="sea"/><g class="land">' + land + hl + '</g>' + dots + pin + '</svg>' +
    '<figcaption>' + esc(opts.caption || '') + '</figcaption></figure>';
}

module.exports = { load, slugify, countryForPoint, countryFromText, haversineKm, neighbors, renderMap, esc };
