'use strict';
/*
 * Vercel serverless function — resolves a channel's current live video id.
 *
 * Two strategies:
 *  1. YouTube Data API v3 (if YOUTUBE_API_KEY is set) — reliable from any IP,
 *     including Vercel's datacenter. This is what makes live TV work in prod.
 *  2. Scrape the /live page — works from residential IPs (local dev), but a
 *     datacenter IP gets the channel's latest upload instead of the live stream,
 *     so this is only a fallback.
 *
 * Pass ?t=1 to force the cheap scrape (used for thumbnails, to save API quota).
 */
const OUTBOUND_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  // consent cookie so YouTube serves the real watch page instead of an interstitial
  Cookie: 'SOCS=CAISNQgDEitib21fdWlfMjAyNTAxMjcuMDNfcDAaAmVuIAEaBgiAwOLABg; CONSENT=YES+; PREF=hl=en&gl=US',
};

// handle (lowercased) -> YouTube channel id, so the Data API needs no extra lookup.
const CHANNEL_IDS = {
  '@aljazeeraenglish': 'UCfiwzLy-8yKzIbsmZTzxDgw',
  '@dwnews': 'UCbbS1GE942k3UVqpLklyhIA',
  '@skynews': 'UCkFclpi8U9VJjfxLYoms7Aw',
  '@abcnews': 'UCBi2mrWuNuyYy4gbM6fU18Q',
  '@channelnewsasia': 'UC83jt4dlz1Gjl58fzQrrKZg',
  '@euronews': 'UCSrZ3UV4jOidv8ppoVuvW9Q',
  '@trtworld': 'UCnyCrv8b7bu0oWFXGyHaPzg',
  '@markets': 'UCIALMKvObZNtJ6AmdCLP7Lg',
  '@livenowfox': 'UCDiPds0v60wueil5B8w3fPQ',
  '@gmanews': 'UCqYw-CTd1dU2yGI71sEyqNw',
  '@abscbnnews': 'UCE2606prvXQc_noEqKxVJXA',
  '@news5everywhere': 'UCGEbMwiX774cseKvJqF9R2g',
};

async function scrapeLive(handle) {
  const upstream = await fetch(`https://www.youtube.com/${handle}/live?hl=en&gl=US`, {
    headers: OUTBOUND_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  const html = await upstream.text();
  // Prefer the page's MAIN video (videoDetails.videoId) — the live stream when
  // the /live redirect resolves — rather than a random recommended thumbnail.
  const m = html.match(/"videoDetails":\{[^}]*?"videoId":"([\w-]{11})"/) || html.match(/"videoId":"([\w-]{11})"/);
  const videoId = m ? m[1] : null;
  const live = /hlsManifestUrl|"isLiveNow":true|BADGE_STYLE_TYPE_LIVE_NOW/.test(html);
  return { videoId, live };
}

async function apiLive(channelId, key) {
  const url = 'https://www.googleapis.com/youtube/v3/search?part=id&type=video&eventType=live'
    + `&maxResults=1&channelId=${channelId}&key=${key}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  const vid = j && j.items && j.items[0] && j.items[0].id && j.items[0].id.videoId;
  return vid || null;
}

module.exports = async (req, res) => {
  const handle = (req.query && req.query.h) || '';
  if (!/^@[\w.\-]{2,40}$/.test(handle)) {
    res.status(400).json({ error: 'bad handle' });
    return;
  }
  const key = process.env.YOUTUBE_API_KEY;
  const cid = CHANNEL_IDS[handle.toLowerCase()];
  const scrapeOnly = req.query && req.query.t === '1';

  try {
    if (key && cid && !scrapeOnly) {
      try {
        const vid = await apiLive(cid, key);
        if (vid) {
          res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
          res.status(200).json({ videoId: vid, live: true, src: 'api' });
          return;
        }
        // Not live right now → fall through to scrape (returns latest, live:false).
      } catch (e) { /* API failed → fall back to scrape */ }
    }
    const scraped = await scrapeLive(handle);
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.status(200).json(scraped);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
