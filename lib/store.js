'use strict';
/*
 * Upstash Redis over its REST API — no SDK, just fetch.
 *
 * Works with either the Vercel-KV integration env vars
 * (KV_REST_API_URL / KV_REST_API_TOKEN) or the native Upstash ones
 * (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN). If neither is set,
 * `configured()` is false and every caller degrades gracefully.
 *
 * Key space (all prefixed wm:):
 *   wm:ev:z     ZSET  score=event-time-ms, member=eventId  (ordering: when it happened)
 *   wm:ev:seen  ZSET  score=first-seen-ms, member=eventId  (retention: when we first stored it)
 *   wm:ev:h     HASH  field=eventId,  value=JSON(event)    (event bodies)
 *   wm:subs     HASH  field=subId,    value=JSON(sub)      (push subscriptions)
 *   wm:stat     HASH  small counters / last-run bookkeeping
 *
 * Retention is keyed on first-seen, not event-time: some feeds (e.g. EONET
 * "open" events) legitimately carry timestamps weeks old, and pruning those by
 * event-time would delete-then-re-ingest them on every poll.
 */

const URL_ =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  '';
const TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  '';

function configured() {
  return Boolean(URL_ && TOKEN);
}

async function call(pathname, body) {
  const r = await fetch(URL_.replace(/\/+$/, '') + pathname, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    // Upstash is fast; keep a tight ceiling so a hung request can't stall a cron.
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('upstash HTTP ' + r.status + ': ' + (await r.text()));
  return r.json();
}

// One command → its result.
async function cmd(args) {
  const j = await call('/', args);
  if (j && j.error) throw new Error('upstash: ' + j.error);
  return j.result;
}

// Many commands in one round-trip → array of results (errors surfaced per-item as null).
async function pipeline(cmds) {
  if (!cmds.length) return [];
  const j = await call('/pipeline', cmds);
  return (Array.isArray(j) ? j : []).map((x) => (x && 'result' in x ? x.result : null));
}

/* -------- event history -------------------------------------------------- */

// Insert freshly-parsed events. Returns the subset that were brand new (not
// seen before) so the caller can decide whether to fire alerts.
//
// Newness is resolved with ONE `ZMSCORE` against wm:ev:seen (which already
// holds every id we have ever stored — a nil score means new), rather than an
// HSETNX per event. Upstash bills each command inside a pipeline separately, so
// the old shape cost one command per event: ~735 per run against the live
// feeds, which exhausts the free tier in days even at hourly ingest. This is
// 1 command on a quiet run and 4 when there is something to write.
//
// Requires Redis 6.2+ for ZMSCORE (Upstash runs 7.x).
async function addEvents(events) {
  if (!events.length) return [];

  const ids = events.map((e) => e.id);
  const scores = await cmd(['ZMSCORE', 'wm:ev:seen', ...ids]);

  const now = Date.now();
  const fresh = [];
  const hset = ['HSET', 'wm:ev:h'];        // bodies
  const zadd = ['ZADD', 'wm:ev:z'];        // score = when it happened
  const zseen = ['ZADD', 'wm:ev:seen'];    // score = when we first saw it

  events.forEach((e, i) => {
    // A null/undefined score means the id is absent, i.e. genuinely new.
    // If ZMSCORE came back malformed, treat everything as new rather than
    // silently dropping a run's events on the floor.
    const known = Array.isArray(scores) && scores[i] !== null && scores[i] !== undefined;
    if (known) return;
    fresh.push(e);
    hset.push(e.id, JSON.stringify(e));
    zadd.push(e.time, e.id);
    zseen.push(now, e.id);
  });

  if (fresh.length) await pipeline([hset, zadd, zseen]);
  return fresh;
}

// Events with time >= sinceMs (or the most recent `limit` when sinceMs is 0),
// newest first. Reads ids from the ZSET then bulk-loads bodies from the HASH.
async function eventsSince(sinceMs, limit = 400) {
  const min = sinceMs > 0 ? sinceMs : '-inf';
  // REV so newest first; cap the working set.
  const ids = await cmd(['ZRANGE', 'wm:ev:z', '+inf', min, 'BYSCORE', 'REV', 'LIMIT', 0, limit]);
  if (!ids || !ids.length) return [];
  const bodies = await cmd(['HMGET', 'wm:ev:h', ...ids]);
  const out = [];
  for (const b of bodies) {
    if (!b) continue;
    try { out.push(JSON.parse(b)); } catch { /* skip corrupt */ }
  }
  return out;
}

// Drop events we FIRST SAW before cutoffMs from every index + the body hash.
// (Keyed on first-seen so still-active feeds with old timestamps aren't churned.)
async function pruneOlderThan(cutoffMs) {
  const stale = await cmd(['ZRANGE', 'wm:ev:seen', '-inf', cutoffMs, 'BYSCORE']);
  if (stale && stale.length) {
    await pipeline([
      ['ZREM', 'wm:ev:z', ...stale],
      ['ZREM', 'wm:ev:seen', ...stale],
      ['HDEL', 'wm:ev:h', ...stale],
    ]);
  }
  return stale ? stale.length : 0;
}

/* -------- push subscriptions -------------------------------------------- */

async function putSub(id, sub) {
  await cmd(['HSET', 'wm:subs', id, JSON.stringify(sub)]);
}
async function getSub(id) {
  const v = await cmd(['HGET', 'wm:subs', id]);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
async function delSub(id) {
  await cmd(['HDEL', 'wm:subs', id]);
}
async function allSubs() {
  const flat = await cmd(['HGETALL', 'wm:subs']); // [field, value, field, value, ...]
  const out = [];
  if (Array.isArray(flat)) {
    for (let i = 0; i < flat.length; i += 2) {
      try { out.push({ id: flat[i], ...JSON.parse(flat[i + 1]) }); } catch { /* skip */ }
    }
  }
  return out;
}

/* -------- bookkeeping ---------------------------------------------------- */

async function setStat(field, value) {
  await cmd(['HSET', 'wm:stat', field, String(value)]);
}
async function getStats() {
  const flat = await cmd(['HGETALL', 'wm:stat']);
  const out = {};
  if (Array.isArray(flat)) for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

module.exports = {
  configured, cmd, pipeline,
  addEvents, eventsSince, pruneOlderThan,
  putSub, getSub, delSub, allSubs,
  setStat, getStats,
};
