// Arabic Sub Fix — إضافة Stremio تجيب الترجمات العربية وتصلحها
// بدون أي مكتبات خارجية: يكفي Node.js 18 أو أحدث، وتشغيله بأمر: node server.js
//
// وش تسوي:
// - تجمع الترجمات العربية من OpenSubtitles (بدون مفتاح) ومن SubDL (بمفتاح مجاني اختياري)
// - تحوّل أي ترميز (Windows-1256 / UTF-16) إلى UTF-8
// - تفك ملفات ZIP وتختار ملف الحلقة الصحيحة
// - تحوّل VTT إلى SRT نظيف وتحذف أكواد ASS مثل {\an8} اللي تخرّب العرض
// - تضبط اتجاه النص العربي عشان علامات الترقيم تطلع بمكانها

const http = require('http');
const zlib = require('zlib');

const PORT = process.env.PORT || 7000;
const SUBDL_API_KEY = process.env.SUBDL_API_KEY || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const FIX_RTL = process.env.FIX_RTL !== '0';
const MAX_PER_SOURCE = parseInt(process.env.MAX_PER_SOURCE || '20', 10);
const OPENSUBS_V3 = 'https://opensubtitles-v3.strem.io';
const ALLOWED_HOSTS = [/(^|\.)strem\.io$/i, /(^|\.)subdl\.com$/i];

const manifest = {
  id: 'community.arabic.subfix',
  version: '1.0.0',
  name: 'Arabic Sub Fix',
  description: 'ترجمات عربية من OpenSubtitles وSubDL بعد تحويلها إلى UTF-8 وإصلاح اتجاه النص',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

// ---------- أدوات عامة ----------
async function fetchWithTimeout(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'ArabicSubFix/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

const encodeToken = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const decodeToken = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

function parseId(id) {
  const [imdb, season, episode] = id.split(':');
  return { imdb, season: season ? +season : null, episode: episode ? +episode : null };
}

// ---------- المصادر ----------
async function fromOpenSubs(type, id, extra) {
  const url = `${OPENSUBS_V3}/subtitles/${type}/${encodeURIComponent(id)}${extra ? '/' + extra : ''}.json`;
  const data = await (await fetchWithTimeout(url)).json();
  return (data.subtitles || [])
    .filter((s) => ['ara', 'ar'].includes(String(s.lang).toLowerCase()))
    .slice(0, MAX_PER_SOURCE)
    .map((s) => ({ src: 'os', url: s.url }));
}

async function fromSubdl(type, imdb, season, episode) {
  if (!SUBDL_API_KEY) return [];
  const p = new URLSearchParams({
    api_key: SUBDL_API_KEY,
    imdb_id: imdb,
    type: type === 'series' ? 'tv' : 'movie',
    languages: 'AR',
    subs_per_page: '30',
  });
  if (type === 'series' && season) {
    p.set('season_number', season);
    if (episode) p.set('episode_number', episode);
  }
  const data = await (await fetchWithTimeout(`https://api.subdl.com/api/v1/subtitles?${p}`)).json();
  if (!data.status) return [];
  return (data.subtitles || [])
    .filter((s) => !(type === 'series' && s.episode && episode && +s.episode !== episode))
    .slice(0, MAX_PER_SOURCE)
    .map((s) => ({
      src: 'subdl',
      url: `https://dl.subdl.com${s.url}`,
      ep: type === 'series' ? { season, episode } : null,
    }));
}

// ---------- إصلاح الملف ----------
function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1256').decode(buf); // أشهر ترميز للترجمات العربية القديمة
  }
}

function normTime(t) {
  const m = t.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
  if (!m) return null;
  const pad = (n, l) => String(n).padStart(l, '0');
  return `${pad(m[1] || 0, 2)}:${pad(m[2], 2)}:${pad(m[3], 2)},${m[4].padEnd(3, '0')}`;
}

function toCleanSrt(text) {
  const blocks = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split(/\n[ \t]*\n/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti === -1) continue;
    const [a, b] = lines[ti].split('-->');
    const start = normTime(a);
    const end = normTime((b || '').trim().split(/\s+/)[0] || '');
    if (!start || !end) continue;
    const body = lines
      .slice(ti + 1)
      .map((l) => l.replace(/\{\\[^}]*\}/g, '').trimEnd())
      .filter((l) => l.trim() !== '')
      .map((l) => (FIX_RTL && /[؀-ۿ]/.test(l) ? `‫${l}‬` : l));
    if (!body.length) continue;
    out.push(`${out.length + 1}\n${start} --> ${end}\n${body.join('\n')}`);
  }
  return out.length ? out.join('\n\n') + '\n' : null;
}

// قارئ ZIP بسيط (بدون مكتبات)
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    entries.push({
      name, size,
      getData() {
        const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
        const raw = buf.subarray(start, start + csize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return zlib.inflateRawSync(raw);
        throw new Error('unsupported zip method ' + method);
      },
    });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

function pickFromZip(buf, ep) {
  const entries = readZip(buf).filter((e) => /\.(srt|vtt)$/i.test(e.name) && !e.name.endsWith('/'));
  if (!entries.length) return null;
  if (ep && ep.season && ep.episode && entries.length > 1) {
    const s = ep.season, e = ep.episode;
    const base = (x) => x.name.split(/[\\/]/).pop();
    // الأنماط الدقيقة أول: S01E01 أو 1x01
    const exact = new RegExp(`(s0*${s}[ ._-]*e0*${e}(?!\\d))|((^|[^\\d])0*${s}x0*${e}(?!\\d))`, 'i');
    // النمط الواسع (E01 / Ep01 / Episode 1) فقط للملفات اللي ما فيها SxxEyy ثاني
    const loose = new RegExp(`e(p|pisode)?[ ._-]*0*${e}(?!\\d)`, 'i');
    const anySxE = /s\d+[ ._-]*e\d+/i;
    const hit = entries.find((x) => exact.test(base(x)))
      || entries.find((x) => !anySxE.test(base(x)) && loose.test(base(x)));
    return hit ? hit.getData() : null;
  }
  return entries.sort((a, b) => b.size - a.size)[0].getData();
}

async function buildSubtitle(tok) {
  const host = new URL(tok.url).hostname;
  if (!ALLOWED_HOSTS.some((r) => r.test(host))) throw new Error('host not allowed');
  let buf = Buffer.from(await (await fetchWithTimeout(tok.url, 15000)).arrayBuffer());
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    buf = pickFromZip(buf, tok.ep);
    if (!buf) return null;
  }
  return toCleanSrt(decodeText(buf));
}

// ---------- كاش بسيط ----------
const cache = new Map();
function cacheSet(k, v) {
  cache.set(k, v);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
}

// ---------- السيرفر ----------
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function send(res, status, body, type, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    ...extraHeaders,
  });
  res.end(body);
}
const sendJson = (res, obj, h) => send(res, 200, JSON.stringify(obj), 'application/json; charset=utf-8', h);

function homePage(base) {
  const mf = `${base}/manifest.json`;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Arabic Sub Fix</title></head>
<body style="font-family:system-ui;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.8">
<h1>Arabic Sub Fix</h1><p>ترجمات عربية مُصلَحة لـ Stremio.</p>
<p><a href="stremio://${mf.replace(/^https?:\/\//, '')}" style="display:inline-block;background:#7b5bf5;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none">تثبيت في Stremio</a></p>
<p>أو انسخ هذا الرابط والصقه في خانة البحث عن الإضافات:</p>
<code style="word-break:break-all;background:#eee;padding:8px;display:block">${mf}</code>
<p>SubDL: ${SUBDL_API_KEY ? 'مفعّل ✅' : 'غير مفعّل (أضف SUBDL_API_KEY)'}</p></body></html>`;
}

async function handleSubtitles(req, res, type, id, extra) {
  const { imdb, season, episode } = parseId(id);
  const results = await Promise.allSettled([fromOpenSubs(type, id, extra), fromSubdl(type, imdb, season, episode)]);
  results.filter((r) => r.status === 'rejected').forEach((r) => console.warn('source error:', r.reason?.message));
  const list = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const base = baseUrl(req);
  sendJson(res, {
    subtitles: list.map((s, i) => ({ id: `asf-${s.src}-${i}`, url: `${base}/sub/${encodeToken(s)}.srt`, lang: 'ara' })),
  }, { 'Cache-Control': 'max-age=3600' });
}

async function handleSub(res, token) {
  try {
    let srt = cache.get(token);
    if (!srt) {
      srt = await buildSubtitle(decodeToken(token));
      if (!srt) return send(res, 404, 'subtitle not found', 'text/plain');
      cacheSet(token, srt);
    }
    send(res, 200, srt, 'text/plain; charset=utf-8', { 'Cache-Control': 'max-age=86400' });
  } catch (e) {
    console.warn('sub error:', e.message);
    send(res, 502, 'failed to fetch subtitle', 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
    if (path === '/' || path === '/configure') return send(res, 200, homePage(baseUrl(req)), 'text/html; charset=utf-8');
    if (path === '/manifest.json') return sendJson(res, manifest);
    let m = path.match(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\/([^/]+))?\.json$/);
    if (m) return await handleSubtitles(req, res, m[1], decodeURIComponent(m[2]), m[3] || '');
    m = path.match(/^\/sub\/([A-Za-z0-9_-]+)\.srt$/);
    if (m) return await handleSub(res, m[1]);
    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    console.warn('error:', e.message);
    if (!res.headersSent) send(res, 500, 'error', 'text/plain');
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Arabic Sub Fix شغّال: http://localhost:${PORT}`));
}

module.exports = { decodeText, toCleanSrt, pickFromZip, readZip, parseId, server };
