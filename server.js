const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const SITE = 'https://alooytv14.xyz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36';

const manifest = {
  id: 'com.naevistv.alooytv',
  version: '1.0.1',
  name: 'AlooyTV',
  description: 'Search AlooyTV directly and provide its episodes/streams.',
  resources: [
    { name: 'catalog', types: ['series'], idPrefixes: ['alooy:'] },
    { name: 'meta', types: ['series'], idPrefixes: ['alooy:'] },
    { name: 'stream', types: ['series'], idPrefixes: ['alooy:'] }
  ],
  types: ['series'],
  catalogs: [
    {
      type: 'series',
      id: 'alooytv_search',
      name: 'AlooyTV',
      extra: [{ name: 'search', isRequired: true }]
    }
  ]
};

const builder = new addonBuilder(manifest);

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en;q=0.8'
      },
      timeout: 15000
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return request(new URL(res.headers.location, url).href, redirects + 1).then(resolve, reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        resolve({ html: data, finalUrl: url, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
  });
}

function abs(href, base = SITE + '/') {
  try { return new URL(href, base).href; } catch (_) { return ''; }
}
function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h,16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
function strip(s) { return decodeHtml(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function enc(s) { return Buffer.from(String(s), 'utf8').toString('base64url'); }
function dec(s) { return Buffer.from(String(s), 'base64url').toString('utf8'); }
function idFor(url) { return 'alooy:' + enc(url); }
function urlFromId(id) { return dec(id.slice('alooy:'.length)); }
function unique(arr) { return [...new Set(arr.filter(Boolean))]; }

function linksFrom(html, base) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = abs(decodeHtml(m[1]), base);
    const text = strip(m[2]);
    if (href) out.push({ href, text });
  }
  return out;
}

function imageFromHtml(html, baseUrl) {
  const candidates = [];
  const add = (value) => {
    if (!value) return;
    const v = abs(decodeHtml(value.trim()), baseUrl);
    if (v && /^https?:\/\//i.test(v)) candidates.push(v);
  };

  // Open Graph image is usually the best poster on WordPress sites.
  let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (m) add(m[1]);
  if (!candidates.length) {
    m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (m) add(m[1]);
  }

  // Twitter image fallback.
  if (!candidates.length) {
    m = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    if (m) add(m[1]);
  }
  if (!candidates.length) {
    m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    if (m) add(m[1]);
  }

  // JSON-LD image fallback.
  if (!candidates.length) {
    const jsonImage = html.match(/"image"\s*:\s*(?:\[\s*)?["']([^"']+)["']/i);
    if (jsonImage) add(jsonImage[1]);
  }

  // WordPress featured-image / thumbnail fallbacks.
  if (!candidates.length) {
    const imgRe = /<img\b[^>]*(?:class=["'][^"']*(?:wp-post-image|post-thumbnail|attachment-post-thumbnail|thumbnail)[^"']*["'])[^>]*>/gi;
    let im;
    while ((im = imgRe.exec(html)) && !candidates.length) {
      const tag = im[0];
      const src = tag.match(/(?:data-src|data-lazy-src|src)=["']([^"']+)["']/i);
      if (src) add(src[1]);
    }
  }

  // Last-resort image: first reasonably-sized-looking image URL in the page.
  if (!candidates.length) {
    const imgRe = /<img\b[^>]*(?:data-src|data-lazy-src|src)=["']([^"']+)["'][^>]*>/gi;
    let im;
    while ((im = imgRe.exec(html))) {
      const u = abs(decodeHtml(im[1]), baseUrl);
      if (u && /^https?:\/\//i.test(u) && !/logo|avatar|icon|emoji|favicon/i.test(u)) {
        candidates.push(u);
        break;
      }
    }
  }

  return candidates[0] || undefined;
}

function titleFromHtml(html) {
  let m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i);
  if (!m) m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? strip(m[1]).replace(/\s*[|–-]\s*AlooyTV.*$/i, '').trim() : 'AlooyTV';
}

function episodeNumber(text, url) {
  const s = (text || '') + ' ' + (url || '');
  const patterns = [
    /(?:Ep|Episode|E|الحلقة|حلقة)\s*#?\s*(\d+)/i,
    /(?:الحلقه)\s*#?\s*(\d+)/i
  ];
  for (const p of patterns) { const m = s.match(p); if (m) return Number(m[1]); }
  return null;
}

function seasonNumber(text, url) {
  const s = (text || '') + ' ' + (url || '');
  const m = s.match(/(?:season|الموسم|موسم)\s*#?\s*(\d+)/i);
  return m ? Number(m[1]) : 1;
}

function findEpisodeLinks(html, baseUrl) {
  const all = linksFrom(html, baseUrl);
  const eps = [];
  for (const x of all) {
    if (!/\/watch\//i.test(x.href)) continue;
    const ep = episodeNumber(x.text, x.href);
    if (ep != null) eps.push({ ...x, episode: ep, season: seasonNumber(x.text, x.href) });
  }
  const map = new Map();
  for (const x of eps) map.set(`${x.season}:${x.episode}`, x);
  return [...map.values()].sort((a,b) => a.season-b.season || a.episode-b.episode);
}

function searchResults(html, baseUrl) {
  const all = linksFrom(html, baseUrl);
  const candidates = [];
  for (const x of all) {
    if (!/^https?:\/\/[^/]+\/watch\//i.test(x.href)) continue;
    if (episodeNumber(x.text, x.href) != null) continue;
    candidates.push(x);
  }
  // AlooyTV search pages can expose a series as a /watch/ page. Deduplicate URLs.
  const seen = new Set();
  return candidates.filter(x => !seen.has(x.href) && seen.add(x.href)).slice(0, 30);
}

function cleanSearchTitle(s) {
  return strip(s).replace(/\s+/g, ' ').trim();
}

builder.defineCatalogHandler(async ({ extra }) => {
  const q = cleanSearchTitle(extra && extra.search);
  if (!q) return { metas: [] };
  try {
    const searchUrl = SITE + '/?s=' + encodeURIComponent(q);
    const { html } = await request(searchUrl);
    const results = searchResults(html, searchUrl);
    const metas = [];
    for (const r of results) {
      const page = await request(r.href).catch(() => null);
      const title = page ? titleFromHtml(page.html) : strip(r.text) || q;
      const eps = page ? findEpisodeLinks(page.html, r.href) : [];
      metas.push({
        id: idFor(r.href),
        type: 'series',
        name: title || strip(r.text) || q,
        poster: page ? imageFromHtml(page.html, r.href) : undefined,
        description: 'AlooyTV',
        videos: eps.slice(0, 200).map(e => ({
          id: idFor(e.href),
          title: e.text || `Episode ${e.episode}`,
          season: e.season,
          episode: e.episode
        }))
      });
    }
    return { metas };
  } catch (e) {
    console.log('[AlooyTV] catalog error:', e.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  try {
    const pageUrl = urlFromId(id);
    const { html } = await request(pageUrl);
    const title = titleFromHtml(html);
    const poster = imageFromHtml(html, pageUrl);
    const eps = findEpisodeLinks(html, pageUrl);
    return {
      meta: {
        id,
        type: 'series',
        name: title,
        poster,
        background: poster,
        videos: eps.map(e => ({
          id: idFor(e.href),
          title: e.text || `Episode ${e.episode}`,
          season: e.season,
          episode: e.episode
        }))
      }
    };
  } catch (e) {
    console.log('[AlooyTV] meta error:', e.message);
    return { meta: { id, type: 'series', name: 'AlooyTV', videos: [] } };
  }
});

function b64decode(s) {
  try { return Buffer.from(s, 'base64').toString('utf8'); } catch (_) { return ''; }
}

function extractDirect(html, pageUrl) {
  const out = [];
  const seen = new Set();
  const add = (url, title) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ name: 'AlooyTV', title, url, quality: 'HD', headers: { Referer: pageUrl, 'User-Agent': UA } });
  };

  // Direct media URLs in source.
  const direct = /https?:\/\/[^"'\\\s<>]+\.(?:m3u8|mp4)(?:\?[^"'\\\s<>]*)?/gi;
  let m;
  while ((m = direct.exec(html))) add(decodeHtml(m[0]), /m3u8/i.test(m[0]) ? 'AlooyTV HLS' : 'AlooyTV MP4');

  // AlooyTV download links contain video_url=BASE64. This is a particularly useful fallback.
  const dl = /(?:href|src)=["'][^"']*download_video\.php\?[^"']*video_url=([^&"']+)/gi;
  while ((m = dl.exec(html))) {
    const v = b64decode(decodeURIComponent(m[1]));
    if (/^https?:\/\//i.test(v)) add(v, /\.m3u8/i.test(v) ? 'AlooyTV HLS' : 'AlooyTV MP4');
  }

  // iframe -> /m3u8/?src=... -> external embed. The stream handler follows this in resolveEmbed().
  const ifr = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  return { streams: out, iframe: ifr ? abs(decodeHtml(ifr[1]), pageUrl) : null };
}

async function resolveEmbed(iframeUrl, referer) {
  const out = [];
  if (!iframeUrl) return out;
  let target = iframeUrl;
  try {
    const u = new URL(iframeUrl);
    const src = u.searchParams.get('src');
    if (src) target = decodeURIComponent(src);
  } catch (_) {}

  const page = await request(target).catch(() => null);
  if (!page) return out;
  const x = extractDirect(page.html, target);
  out.push(...x.streams);

  // Common player configs: file:"...m3u8" / src:"...m3u8" / source:"..."
  const cfg = /(?:file|src|source|hls|playlist)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi;
  let m;
  while ((m = cfg.exec(page.html))) {
    if (/\.(?:m3u8|mp4)/i.test(m[1])) {
      out.push({ name:'AlooyTV', title:'AlooyTV Player', url:m[1], quality:'HD', headers:{ Referer:target, 'User-Agent':UA } });
    }
  }
  return uniqueStreams(out);
}
function uniqueStreams(arr) {
  const seen = new Set(); return arr.filter(x => x && x.url && !seen.has(x.url) && seen.add(x.url));
}

builder.defineStreamHandler(async ({ id }) => {
  try {
    const pageUrl = urlFromId(id);
    const { html } = await request(pageUrl);
    const direct = extractDirect(html, pageUrl);
    let streams = direct.streams;
    if (direct.iframe) streams = streams.concat(await resolveEmbed(direct.iframe, pageUrl));
    streams = uniqueStreams(streams);
    console.log('[AlooyTV] streams', streams.length, pageUrl);
    return { streams };
  } catch (e) {
    console.log('[AlooyTV] stream error:', e.message);
    return { streams: [] };
  }
});

const port = Number(process.env.PORT || 7000);
serveHTTP(builder.getInterface(), { port });
console.log(`AlooyTV addon listening on port ${port}`);
