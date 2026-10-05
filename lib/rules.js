'use strict';
/*
 * Alert rules. A subscription carries an array of rules; an event notifies the
 * subscriber if ANY rule matches. Rule shapes (all fields optional unless noted):
 *
 *   { type:'quake',   minMag:6 }                         M6.0+ anywhere
 *   { type:'alert',   minSev:'high', countries:[..] }    severe GDACS alert
 *                                                        (countries = watchlist; empty = anywhere)
 *   { type:'cyclone', minCat:3 }                         new Cat-3+ tropical cyclone
 *   { type:'event',   categories:['Wildfires', ..] }     EONET natural events
 *   { type:'country', countries:['Japan', ..] }          anything in a watchlist country
 */

const SEV_RANK = { extreme: 4, high: 3, moderate: 2, low: 1 };
function sevRank(s) { return SEV_RANK[s] || 0; }

function inCountries(event, countries) {
  if (!countries || !countries.length) return true; // "anywhere"
  const hay = ((event.country || '') + ' ' + (event.place || '') + ' ' + (event.title || '')).toLowerCase();
  return countries.some((c) => c && hay.includes(String(c).toLowerCase()));
}

// Returns a short reason string if the event matches the rule, else null.
function matchRule(event, rule) {
  if (!rule || !rule.type) return null;
  switch (rule.type) {
    case 'quake':
      if (event.layer === 'quakes' && (event.mag || 0) >= (rule.minMag ?? 6))
        return 'M' + (event.mag || 0).toFixed(1) + ' earthquake';
      return null;
    case 'alert':
      if (event.layer === 'alerts'
          && sevRank(event.sev) >= sevRank(rule.minSev || 'high')
          && inCountries(event, rule.countries))
        return (event.sev === 'extreme' ? 'Red' : 'Orange') + ' ' + event.kind + ' alert';
      return null;
    case 'cyclone':
      if (event.eventtype === 'TC' && (event.cat || 0) >= (rule.minCat ?? 3))
        return 'Category ' + event.cat + ' cyclone';
      return null;
    case 'event':
      if (event.layer === 'events'
          && (!rule.categories || !rule.categories.length || rule.categories.includes(event.kind)))
        return event.kind;
      return null;
    case 'country':
      if (rule.countries && rule.countries.length && inCountries(event, rule.countries))
        return 'Activity in ' + (event.country || event.place || 'watchlist');
      return null;
    default:
      return null;
  }
}

// First matching reason across a subscription's rules, or null.
function matchEvent(event, rules) {
  if (!Array.isArray(rules)) return null;
  for (const r of rules) {
    const reason = matchRule(event, r);
    if (reason) return reason;
  }
  return null;
}

function titleFor(event) {
  if (event.layer === 'quakes') return 'M' + (event.mag || 0).toFixed(1) + ' earthquake';
  if (event.eventtype === 'TC') return 'Cyclone' + (event.cat ? ' — Category ' + event.cat : '');
  if (event.layer === 'alerts') return (event.sev === 'extreme' ? 'Red' : 'Orange') + ' ' + event.kind + ' alert';
  return event.kind || 'Global event';
}

// Web-push notification payload (consumed by sw.js).
function buildPayload(event, reason) {
  const where = event.country || event.place || '';
  return {
    title: titleFor(event),
    body: (event.title || '') + (where && !(event.title || '').includes(where) ? ' — ' + where : ''),
    reason: reason || '',
    tag: event.id,
    url: event.url || '',
    sev: event.sev,
    lat: event.lat,
    lon: event.lon,
    ts: event.time,
  };
}

module.exports = { matchEvent, matchRule, buildPayload, titleFor, sevRank };
