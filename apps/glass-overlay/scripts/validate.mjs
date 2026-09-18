#!/usr/bin/env bun
// scripts/validate.mjs — durable synthetic validation harness for Glassy Overlay.
// Headless Chromium + stubbed daemon (fake WebSocket) + file:// pages.
// Groups: A overlay idle/config/weather, B settings page, C idle input guard,
// D companion defaults. Exits non-zero on any failure.
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CHROME = '/opt/meta-chromium/chrome';
const MSGPACK_UMD = readFileSync(join(ROOT, 'node_modules/@msgpack/msgpack/dist.umd/msgpack.min.js'), 'utf8');

const results = [];
let passCount = 0, failCount = 0;
function check(group, name, cond, detail = '') {
  const ok = !!cond;
  ok ? passCount++ : failCount++;
  results.push({ group, name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${group}: ${name}${detail && !ok ? ' -> ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- fake daemon (injected into every test page) ---------------- */

const DAEMON_JS = `
window.__daemonCmds = [];
window.__daemonNetUrls = [];
window.__daemonRequests = [];
function __uuidStr(b) {
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0,8) + '-' + h.slice(8,12) + '-' + h.slice(12,16) + '-' + h.slice(16,20) + '-' + h.slice(20);
}
function __netFixture(url) {
  if (url.indexOf('geocoding-api.open-meteo.com') >= 0)
    return { status: 200, body: JSON.stringify({ results: [{ latitude: 48.8566, longitude: 2.3522, name: 'Paris' }] }) };
  const u = new URL(url);
  const metric = u.searchParams.get('temperature_unit') === 'celsius';
  const night = (window.__daemonCfg || {}).night === true;
  const t = metric ? 22 : 72, hi = metric ? 25 : 76, lo = metric ? 11 : 52;
  const codes = [1, 2, 0, 61, 0];
  const days = [];
  for (let i = 0; i < 5; i++) days.push({ date: '2026-09-' + (15 + i), high: hi - i, low: lo - i, code: codes[i] });
  return { status: 200, body: JSON.stringify({
    current: { temperature_2m: t, relative_humidity_2m: 55, weather_code: night ? 0 : 1, wind_speed_10m: 8, is_day: night ? 0 : 1 },
    daily: { time: days.map(d => d.date), temperature_2m_max: days.map(d => d.high),
             temperature_2m_min: days.map(d => d.low), weather_code: days.map(d => d.code) } }) };
}
function __daemonHandle(ws, frame) {
  let msg;
  try { msg = MessagePack.decode(frame instanceof Uint8Array ? frame : new Uint8Array(frame)); }
  catch (e) { return; }
  const id = (msg.id instanceof Uint8Array) ? __uuidStr(msg.id) : String(msg.id);
  const kind = msg.meta && msg.meta.kind;
  const d = msg.data || {}, inner = d.data || {};
  window.__daemonRequests.push({ kind, type: d.type, event: inner.event });
  if (kind === 'command') {
    window.__daemonCmds.push({ type: d.type, event: inner.event, data: inner.data });
    return;
  }
  if (kind !== 'request') return;
  const cfg = window.__daemonCfg || {};
  let reply = null;
  if (d.type === 'config' && inner.event === 'get') {
    const v = (cfg.config || {})[inner.data.key];
    reply = { type: 'config', data: { event: 'get', data: { value: v !== undefined ? v : null } } };
  } else if (d.type === 'config' && inner.event === 'list') {
    const entries = Object.entries(cfg.config || {}).map(([key, value]) => ({ key, value }));
    reply = { type: 'config', data: { event: 'list', data: { entries } } };
  } else if (d.type === 'net' && inner.event === 'fetch') {
    const url = inner.data.request.url;
    window.__daemonNetUrls.push(url);
    reply = { type: 'net', data: { event: 'fetchReply', data: { response: __netFixture(url) } } };
  } else if (d.type === 'geo' && inner.event === 'getOnce') {
    if (cfg.geo === 'ok') reply = { type: 'geo', data: { event: 'getOnceReply', data: { position: { lat: 40.7128, lon: -74.006 } } } };
    else if (cfg.geo === 'error') reply = { type: 'geo', data: { event: 'errorReply', data: { type: 'unavailable' } } };
  } else if (d.type === 'time' && inner.event === 'get') {
    reply = { type: 'time', data: { event: 'snapshot', data: { time: { tzIana: 'America/New_York', utcOffsetMinutes: -300, dstOffsetMinutes: 60 } } } };
  } else if (d.type === 'hardware' && inner.event === 'stateGet') {
    reply = { type: 'hardware', data: { event: 'stateReply', data: { state: { brightness: { level: 1, mode: 'auto' } } } } };
  } else if (d.type === 'player' && inner.event === 'stateGet') {
    reply = { type: 'player', data: { event: 'stateReply', data: { state: cfg.playerState === 'playing'
      ? { playback: { state: 'playing' }, track: { title: 'Test Track', artist: 'Test Artist' } }
      : { playback: { state: 'paused' }, track: null } } } };
  }
  if (reply) setTimeout(() => ws._recv({ id, meta: { kind: 'response', data: { requestId: id } }, data: reply }), 5);
}
window.WebSocket = class FakeWebSocket {
  constructor(url) {
    this.url = url; this._l = {};
    window.__daemonSockets = window.__daemonSockets || [];
    window.__daemonSockets.push(this);
    const s = this; setTimeout(() => s._emit('open', {}), 5);
  }
  addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
  removeEventListener(t, f) { const a = this._l[t]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } }
  set binaryType(v) { this._bt = v; }
  get binaryType() { return this._bt || 'arraybuffer'; }
  get readyState() { return 1; }
  send(frame) { try { __daemonHandle(this, frame); } catch (e) { (window.__glassErrors = window.__glassErrors || []).push('daemon: ' + e.message); } }
  close() { const s = this; setTimeout(() => s._emit('close', { code: 1000, reason: '', wasClean: true }), 0); }
  _recv(obj) { this._emit('message', { data: JSON.stringify(obj) }); }
  _emit(t, e) { (this._l[t] || []).slice().forEach(f => { try { f.call(this, e); } catch (err) { (window.__glassErrors = window.__glassErrors || []).push('ws-listener: ' + err.message); } }); }
};
window.__daemonPushConfigChanged = function (key, value) {
  window.__daemonCfg = window.__daemonCfg || {};
  window.__daemonCfg.config = window.__daemonCfg.config || {};
  if (value == null) delete window.__daemonCfg.config[key];
  else window.__daemonCfg.config[key] = value;
  const obj = { id: '00000000-0000-0000-0000-000000000000', meta: { kind: 'event' },
    data: { type: 'config', data: { event: 'changed', data: { key, value } } } };
  (window.__daemonSockets || []).forEach(s => { try { s._recv(obj); } catch (e) {} });
};
`;

const ERROR_HOOK = `
window.__glassErrors = [];
window.addEventListener('error', e => window.__glassErrors.push('error: ' + e.message));
window.addEventListener('unhandledrejection', e => window.__glassErrors.push('rejection: ' + ((e.reason && e.reason.message) || String(e.reason))));
`;

const SHADOW_PATCH = `
window.__glassShadows = [];
const __origAttach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (init) {
  const s = __origAttach.call(this, { mode: 'open' });
  window.__glassShadows.push(s);
  return s;
};
`;

const PROBE_JS = `
window.__glassProbe = function () {
  const sh = window.__glassShadows[window.__glassShadows.length - 1];
  const dash = sh ? sh.querySelector('[data-testid="ambient-dashboard"]') : null;
  const glyphEls = dash ? Array.from(dash.querySelectorAll('span[aria-hidden="true"]')) : [];
  return {
    ambient: !!dash,
    errors: window.__glassErrors.slice(),
    cmds: window.__daemonCmds.slice(),
    netUrls: window.__daemonNetUrls.slice(),
    glyphs: glyphEls.map(s => s.textContent),
    hasSvg: !!(dash && dash.querySelector('svg')),
    text: dash ? dash.textContent.slice(0, 500) : null,
    tiles: dash ? dash.querySelectorAll('.forecast-box').length : 0,
    mono: !!(dash && dash.querySelector('.font-mono')),
    tileHtml: dash && dash.querySelector('.forecast-box') ? dash.querySelector('.forecast-box').innerHTML.slice(0, 400) : null,
  };
};
`;

function overlayHostHtml(overlayCfg, daemonCfg) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>${MSGPACK_UMD}</script>
<script>window.__daemonCfg = ${JSON.stringify(daemonCfg)};${DAEMON_JS}</script>
<script>${ERROR_HOOK}${SHADOW_PATCH}${PROBE_JS}
window.__bridgethingOverlay = ${JSON.stringify(overlayCfg)};
</script>
<script src="./overlay.js"></script>
</body></html>`;
}

function settingsHostHtml(daemonCfg) {
  const src = readFileSync(join(SCRATCH, 'dist', 'index.html'), 'utf8');
  const inject = `<script>${MSGPACK_UMD}</script>\n<script>window.__daemonCfg = ${JSON.stringify(daemonCfg)};${DAEMON_JS}</script>\n<script>${ERROR_HOOK}</script>\n`;
  return src.replace(/<script type="module"/, inject + '<script type="module"');
}

/* ---------------- CDP + Chromium ---------------- */

const SCRATCH = join(tmpdir(), 'glass-validate-' + Date.now());
mkdirSync(join(SCRATCH, 'dist'), { recursive: true });
mkdirSync(join(SCRATCH, 'profile'), { recursive: true });
cpSync(join(ROOT, 'dist'), join(SCRATCH, 'dist'), { recursive: true });

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.method + ': ' + JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) (this.handlers.get(m.method) || []).forEach(h => h(m.params));
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(method, h) { this.handlers.set(method, [...(this.handlers.get(method) || []), h]); }
}

let chromeProc = null, cdp = null, dbgPort = 0;

async function launchBrowser() {
  chromeProc = spawn(CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--allow-file-access-from-files', '--remote-debugging-port=0',
    '--user-data-dir=' + join(SCRATCH, 'profile'), 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise((res, rej) => {
    let buf = '';
    const to = setTimeout(() => rej(new Error('no devtools url')), 15000);
    chromeProc.stderr.on('data', d => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (m) { clearTimeout(to); res(m[1]); }
    });
    chromeProc.on('exit', () => rej(new Error('chrome exited early')));
  });
  dbgPort = Number(new URL(url).port);
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  cdp = new CDP(ws);
}

async function newPage(file, { seed = {}, reloadAfterSeed = true } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p = {}) => cdp.send(m, p, sessionId);
  await send('Page.enable'); await send('Runtime.enable');
  const loaded = new Promise(r => cdp.on('Page.loadEventFired', function h() { r(); }));
  await send('Page.navigate', { url: 'file://' + join(SCRATCH, file) });
  await loaded; await sleep(1200);
  if (Object.keys(seed).length || reloadAfterSeed) {
    const expr = 'localStorage.clear();' + Object.entries(seed)
      .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('');
    await send('Runtime.evaluate', { expression: expr });
    const reloaded = new Promise(r => cdp.on('Page.loadEventFired', function h2() { r(); }));
    await send('Page.reload'); await reloaded; await sleep(1200);
  }
  return {
    sessionId, targetId,
    eval: (expression, awaitPromise = false) =>
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }).then(r => {
        if (r.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
        return r.result.value;
      }),
    close: () => cdp.send('Target.closeTarget', { targetId }),
  };
}

const OVERLAY_CFG = (over = {}) => Object.assign({
  origin: 'file://',
  url: 'ws://127.0.0.1:8891/?scope=overlay',
  surfaces: { notifications: true, call: true, pairing: true, connection: true, volume: true, voice: true },
}, over);
const DAEMON_CFG = (over = {}) => Object.assign(
  { config: {}, geo: 'ok', playerState: 'playing' }, over);

function writeOverlayHost(name, overlayCfg, daemonCfg) {
  writeFileSync(join(SCRATCH, 'dist', name), overlayHostHtml(overlayCfg, daemonCfg));
}

const dimmed = p => p.cmds.some(c => c.event === 'displaySetLevel' && c.data && Math.abs(c.data.level - 0.15) < 1e-9);
const noErr = p => p.errors.length === 0;

/* ---------------- Group A: overlay idle / config / weather ---------------- */

async function groupA() {
  // A1: config 15s -> ambient + dim ~15s, emoji glyph, no SVG, zero errors
  writeOverlayHost('a1.html', OVERLAY_CFG(), DAEMON_CFG({ geo: 'ok', config: { ambient_idle_s: '15' } }));
  {
    const pg = await newPage('dist/a1.html');
    let p = await pg.eval('window.__glassProbe()');
    check('A', 'config 15s: hidden at t~1s', !p.ambient && noErr(p), JSON.stringify(p.errors));
    await sleep(17000);
    p = await pg.eval('window.__glassProbe()');
    check('A', 'config 15s: ambient shown at t~18s', p.ambient, 'ambient=' + p.ambient);
    check('A', 'config 15s: dimmed to 15%', dimmed(p), JSON.stringify(p.cmds));
    check('A', 'config 15s: zero JS errors', noErr(p), JSON.stringify(p.errors));
    check('A', 'config 15s: emoji glyph rendered', p.glyphs.length > 0 && p.glyphs.every(g => g && g.length > 0),
      JSON.stringify(p.glyphs));
    check('A', 'config 15s: no SVG glyphs', !p.hasSvg, 'hasSvg=' + p.hasSvg);
    check('A', 'config 15s: 5 forecast tiles', p.tiles === 5, 'tiles=' + p.tiles);
    check('A', 'config 15s: mono meta lines', p.mono, 'mono=' + p.mono);
    check('A', 'config 15s: weather request includes is_day',
      p.netUrls.some(u => u.includes('current=') && u.includes('is_day')), '');
    const padCls = await pg.eval(`(() => { const sh = window.__glassShadows[window.__glassShadows.length - 1]; const d = sh.querySelector('[data-testid="ambient-dashboard"]'); return d && d.firstElementChild ? d.firstElementChild.className : null; })()`);
    check('A', 'config 15s: ambient top block uses pt-20', !!(padCls && padCls.includes('pt-20')), padCls);
    await pg.close();
  }
  // A1b: night + clear -> moon glyph on the main tile
  writeOverlayHost('a1b.html', OVERLAY_CFG(), DAEMON_CFG({ night: true, config: { ambient_idle_s: '15' } }));
  {
    const pg = await newPage('dist/a1b.html', { seed: { 'glassy.weather_location': '40.7,-74.0' } });
    await sleep(18000);
    const p = await pg.eval('window.__glassProbe()');
    check('A', 'night: ambient shown', p.ambient && noErr(p), JSON.stringify(p.errors));
    check('A', 'night: main glyph is moon', p.glyphs.length > 0 && p.glyphs[0] === '🌙',
      JSON.stringify(p.glyphs));
    check('A', 'night: forecast tiles keep day glyphs', p.glyphs.slice(1).every(g => g && g !== '🌙'),
      JSON.stringify(p.glyphs));
    await pg.close();
  }
  // A2: config 1s clamps to 15s minimum
  writeOverlayHost('a2.html', OVERLAY_CFG(), DAEMON_CFG({ config: { ambient_idle_s: '1' } }));
  {
    const pg = await newPage('dist/a2.html');
    await sleep(6000);
    let p = await pg.eval('window.__glassProbe()');
    check('A', 'clamp-min: hidden at t~7s (not 1s)', !p.ambient && noErr(p));
    await sleep(12000);
    p = await pg.eval('window.__glassProbe()');
    check('A', 'clamp-min: ambient shown at t~19s', p.ambient && noErr(p));
    await pg.close();
  }
  // A3: garbage config -> 30s default
  writeOverlayHost('a3.html', OVERLAY_CFG(), DAEMON_CFG({ config: { ambient_idle_s: 'soon' } }));
  {
    const pg = await newPage('dist/a3.html');
    await sleep(18000);
    let p = await pg.eval('window.__glassProbe()');
    check('A', 'garbage config: hidden at t~19s (30s default)', !p.ambient && noErr(p));
    await sleep(15000);
    p = await pg.eval('window.__glassProbe()');
    check('A', 'garbage config: ambient shown at t~34s', p.ambient && noErr(p));
    await pg.close();
  }
  // A4: no config -> 30s default
  writeOverlayHost('a4.html', OVERLAY_CFG({}), DAEMON_CFG());
  {
    const pg = await newPage('dist/a4.html');
    await sleep(18000);
    let p = await pg.eval('window.__glassProbe()');
    check('A', 'no config: hidden at t~19s (30s default)', !p.ambient && noErr(p));
    await sleep(15000);
    p = await pg.eval('window.__glassProbe()');
    check('A', 'no config: ambient shown at t~34s', p.ambient && dimmed(p) && noErr(p));
    await pg.close();
  }
  // A5: localStorage 15s at boot
  writeOverlayHost('a5.html', OVERLAY_CFG({}), DAEMON_CFG());
  {
    const pg = await newPage('dist/a5.html', { seed: { 'glassy.ambient_idle_s': '15' } });
    await sleep(4000);
    let p = await pg.eval('window.__glassProbe()');
    check('A', 'localStorage 15s: hidden at t~5s', !p.ambient && noErr(p));
    await sleep(13000);
    p = await pg.eval('window.__glassProbe()');
    check('A', 'localStorage 15s: shown+dimmed at t~18s', p.ambient && dimmed(p) && noErr(p));
    await pg.close();
  }
  // A6: live localStorage write re-arms the timer (storage event, as the
  // settings page triggers cross-document; same-page setItem alone fires no event)
  writeOverlayHost('a6.html', OVERLAY_CFG({}), DAEMON_CFG());
  {
    const pg = await newPage('dist/a6.html');
    await pg.eval(`{ localStorage.setItem('glassy.ambient_idle_s', '15'); window.dispatchEvent(new StorageEvent('storage', { key: 'glassy.ambient_idle_s' })); }`);
    await sleep(8000);
    let p = await pg.eval('window.__glassProbe()');
    check('A', 'live update: hidden at t~9s', !p.ambient && noErr(p));
    await sleep(13000);
    p = await pg.eval('window.__glassProbe()');
    check('A', 'live update: shown at t~22s (before 30s default)', p.ambient && noErr(p));
    await pg.close();
  }
  // A7: metric units + lat,lon location
  writeOverlayHost('a7.html', OVERLAY_CFG(), DAEMON_CFG({ config: { ambient_idle_s: '15' } }));
  {
    const pg = await newPage('dist/a7.html', {
      seed: { 'glassy.weather_units': 'metric', 'glassy.weather_location': '40.7128,-74.0060' },
    });
    await sleep(18000);
    const p = await pg.eval('window.__glassProbe()');
    check('A', 'metric: ambient shown', p.ambient && noErr(p), JSON.stringify(p.errors));
    check('A', 'metric: forecast requested in celsius', p.netUrls.some(u => u.includes('temperature_unit=celsius')),
      p.netUrls.filter(u => u.includes('open-meteo')).join(' | ').slice(0, 160));
    check('A', 'metric: renders °C', !!(p.text && p.text.includes('°C')), (p.text || '').slice(0, 80));
    check('A', 'metric: lat,lon used', p.netUrls.some(u => u.includes('latitude=40.7128')), '');
    await pg.close();
  }
  // A8: imperial default + lat,lon location
  writeOverlayHost('a8.html', OVERLAY_CFG(), DAEMON_CFG({ config: { ambient_idle_s: '15' } }));
  {
    const pg = await newPage('dist/a8.html', { seed: { 'glassy.weather_location': '40.7,-74.0' } });
    await sleep(18000);
    const p = await pg.eval('window.__glassProbe()');
    check('A', 'imperial: forecast requested in fahrenheit', p.netUrls.some(u => u.includes('temperature_unit=fahrenheit')), '');
    check('A', 'imperial: renders °F', !!(p.text && p.text.includes('°F')), (p.text || '').slice(0, 80));
    check('A', 'imperial: zero JS errors', noErr(p), JSON.stringify(p.errors));
    await pg.close();
  }
  // A9: city geocode via stubbed Open-Meteo, result cached
  writeOverlayHost('a9.html', OVERLAY_CFG(), DAEMON_CFG({ config: { ambient_idle_s: '15' } }));
  {
    const pg = await newPage('dist/a9.html', { seed: { 'glassy.weather_location': 'Paris' } });
    await sleep(18000);
    const p = await pg.eval('window.__glassProbe()');
    const cache = await pg.eval(`localStorage.getItem('glassy.weather_location_cache')`);
    check('A', 'geocode: geocoding API called', p.netUrls.some(u => u.includes('geocoding-api.open-meteo.com')), '');
    check('A', 'geocode: forecast uses geocoded lat', p.netUrls.some(u => u.includes('latitude=48.8566')), '');
    check('A', 'geocode: result cached', !!(cache && cache.includes('48.8566')), String(cache).slice(0, 80));
    check('A', 'geocode: zero JS errors', noErr(p), JSON.stringify(p.errors));
    await pg.close();
  }
  // A10: blank location + geo timeout -> home constants fallback
  writeOverlayHost('a10.html', OVERLAY_CFG(), DAEMON_CFG({ geo: 'timeout', config: { ambient_idle_s: '15' } }));
  {
    const pg = await newPage('dist/a10.html');
    await sleep(28000);
    const p = await pg.eval('window.__glassProbe()');
    check('A', 'geo timeout: ambient shown', p.ambient && noErr(p), JSON.stringify(p.errors));
    check('A', 'geo timeout: falls back to home lat/lon', p.netUrls.some(u => u.includes('latitude=40.15596')), '');
    await pg.close();
  }
  // A11: 0.13.1 prelude -> overlay opens the scoped client URL
  writeOverlayHost('a11.html', OVERLAY_CFG(), DAEMON_CFG());
  {
    const pg = await newPage('dist/a11.html');
    await sleep(3000);
    const urls = await pg.eval(`(window.__daemonSockets || []).map(s => s.url)`);
    const reqs = await pg.eval(`window.__daemonRequests.map(r => r.type + '/' + r.event)`);
    check('A', 'scoped client: connects with ?scope=overlay', urls.some(u => u.includes('scope=overlay')), JSON.stringify(urls));
    check('A', 'scoped client: companion config listed at boot', reqs.includes('config/list'), JSON.stringify(reqs));
    check('A', 'scoped client: zero JS errors', noErr(await pg.eval('window.__glassProbe()')));
    await pg.close();
  }
  // A12/A13: companion dim level via list, then live via ConfigChanged
  writeOverlayHost('a12.html', OVERLAY_CFG(), DAEMON_CFG({ config: { ambient_idle_s: '15', ambient_dim_level: '42' } }));
  {
    const pg = await newPage('dist/a12.html');
    await sleep(19000);
    let p = await pg.eval('window.__glassProbe()');
    const lvl = c => c.event === 'displaySetLevel' && c.data && Math.abs(c.data.level - 0.42) < 1e-9;
    check('A', 'companion dim: ambient shown', p.ambient && noErr(p), JSON.stringify(p.errors));
    check('A', 'companion dim: list value applied (42%)', p.cmds.some(lvl),
      p.cmds.filter(c => c.event === 'displaySetLevel').map(c => c.data && c.data.level).join(','));
    const before = p.cmds.length;
    await pg.eval(`window.__daemonPushConfigChanged('ambient_dim_level', '80')`);
    await sleep(2500);
    p = await pg.eval('window.__glassProbe()');
    const fresh = p.cmds.slice(before);
    check('A', 'companion dim: live change re-dims to 80%',
      fresh.some(c => c.event === 'displaySetLevel' && c.data && Math.abs(c.data.level - 0.8) < 1e-9),
      fresh.filter(c => c.event === 'displaySetLevel').map(c => c.data && c.data.level).join(','));
    check('A', 'companion dim: zero JS errors', noErr(p), JSON.stringify(p.errors));
    await pg.close();
  }
  // A14: companion weather_location change reloads weather live
  writeOverlayHost('a14.html', OVERLAY_CFG(), DAEMON_CFG({ config: { ambient_idle_s: '15', weather_location: 'Paris' } }));
  {
    const pg = await newPage('dist/a14.html');
    await sleep(19000);
    let p = await pg.eval('window.__glassProbe()');
    check('A', 'companion location: Paris geocoded', p.netUrls.some(u => u.includes('geocoding-api.open-meteo.com') && u.includes('name=Paris')), '');
    const before = p.netUrls.length;
    await pg.eval(`window.__daemonPushConfigChanged('weather_location', 'Berlin')`);
    await sleep(4000);
    p = await pg.eval('window.__glassProbe()');
    const fresh = p.netUrls.slice(before);
    check('A', 'companion location: live change re-geocodes Berlin',
      fresh.some(u => u.includes('geocoding-api.open-meteo.com') && u.includes('name=Berlin')),
      fresh.join(' | ').slice(0, 200));
    check('A', 'companion location: zero JS errors', noErr(p), JSON.stringify(p.errors));
    await pg.close();
  }
  // A15: 0.12.x prelude (no url) -> no config.list, mirror-only fallback
  writeOverlayHost('a15.html', OVERLAY_CFG({ url: undefined }), DAEMON_CFG({ config: { ambient_dim_level: '42' } }));
  {
    const pg = await newPage('dist/a15.html');
    await sleep(3000);
    const reqs = await pg.eval(`window.__daemonRequests.map(r => r.type + '/' + r.event)`);
    const urls = await pg.eval(`(window.__daemonSockets || []).map(s => s.url)`);
    check('A', 'legacy prelude: no config requests without scoped url', !reqs.some(r => r.startsWith('config/')), JSON.stringify(reqs));
    check('A', 'legacy prelude: connects unscoped', urls.some(u => !u.includes('scope=')), JSON.stringify(urls));
    check('A', 'legacy prelude: zero JS errors', noErr(await pg.eval('window.__glassProbe()')));
    await pg.close();
  }
  // A16: companion ambient_idle_s change re-arms the idle timer live
  writeOverlayHost('a16.html', OVERLAY_CFG(), DAEMON_CFG());
  {
    const pg = await newPage('dist/a16.html');
    await sleep(5000);
    await pg.eval(`window.__daemonPushConfigChanged('ambient_idle_s', '15')`);
    await sleep(17000);
    const p = await pg.eval('window.__glassProbe()');
    check('A', 'companion idle: live change shows ambient before the 30s default', p.ambient && noErr(p), JSON.stringify(p.errors));
    await pg.close();
  }
}

/* ---------------- Group B: settings page ---------------- */

async function groupB() {
  writeFileSync(join(SCRATCH, 'dist', 'settings.html'), settingsHostHtml(DAEMON_CFG()));
  const pg = await newPage('dist/settings.html', { reloadAfterSeed: false });
  const btn = (sel, text) =>
    `[...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
  const ls = k => pg.eval(`localStorage.getItem(${JSON.stringify(k)})`);

  // B1: tile click persists + active state + Saved message
  await pg.eval(`${btn('#idle-tiles button', '1m')}.click()`);
  await sleep(300);
  check('B', 'tile click persists', (await ls('glassy.ambient_idle_s')) === '60');
  check('B', 'tile click marks active', await pg.eval(`${btn('#idle-tiles button', '1m')}.classList.contains('active')`));
  check('B', 'tile click shows Saved', (await pg.eval(`document.getElementById('saved').textContent`)) === 'Saved');

  // B2: persists across reload
  await pg.eval(`location.reload()`);
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if ((await pg.eval(`document.querySelectorAll('#idle-tiles button').length`)) > 0) break;
  }
  check('B', 'tile persists across reload', await pg.eval(`${btn('#idle-tiles button', '1m')}.classList.contains('active')`));

  // B3: location save
  await pg.eval(`{ const i = document.getElementById('location'); i.value = 'Paris'; i.dispatchEvent(new Event('change', {bubbles:true})); }`);
  await sleep(300);
  check('B', 'location save stores value', (await ls('glassy.weather_location')) === 'Paris');
  check('B', 'location save shows Saved', (await pg.eval(`document.getElementById('saved').textContent`)) === 'Saved');

  // B4: blank location clears
  await pg.eval(`{ const i = document.getElementById('location'); i.value = ''; i.dispatchEvent(new Event('change', {bubbles:true})); }`);
  await sleep(300);
  check('B', 'blank location clears override', (await ls('glassy.weather_location')) === null);

  // B5: units toggle
  await pg.eval(`${btn('#units button', 'Metric')}.click()`);
  await sleep(300);
  check('B', 'units toggle stores metric', (await ls('glassy.weather_units')) === 'metric');
  check('B', 'units toggle marks active', await pg.eval(`${btn('#units button', 'Metric')}.classList.contains('active')`));

  // B6: units persist across reload
  await pg.eval(`location.reload()`);
  await sleep(1500);
  check('B', 'units persist across reload', await pg.eval(`${btn('#units button', 'Metric')}.classList.contains('active')`));

  // B7: intensity slider persists + readout updates
  await pg.eval(`{ const s = document.getElementById('dim'); s.value = '35'; s.dispatchEvent(new Event('input', {bubbles:true})); s.dispatchEvent(new Event('change', {bubbles:true})); }`);
  await sleep(300);
  check('B', 'slider persists intensity', (await ls('glassy.ambient_dim_level')) === '35');
  check('B', 'slider readout updates', (await pg.eval(`document.getElementById('dimval').textContent`)) === '35%');

  const errs = await pg.eval(`window.__glassErrors.slice()`);
  check('B', 'settings page: zero JS errors', errs.length === 0, JSON.stringify(errs));
  await pg.close();
}

/* ---------------- Group C: idle input guard ---------------- */

async function groupC() {
  writeOverlayHost('c.html', OVERLAY_CFG(), DAEMON_CFG({ config: { ambient_idle_s: '15' } }));
  const pump = `document.dispatchEvent(new Event('touchmove', { bubbles: true, cancelable: true }))`;

  // C1+C2: pumping touchmove suppresses ambient past the 15s timeout; ambient appears ~15s after last input
  {
    const pg = await newPage('dist/c.html');
    for (let i = 0; i < 10; i++) { await pg.eval(pump); await sleep(2000); }
    let p = await pg.eval('window.__glassProbe()');
    check('C', 'touchmove pump suppresses ambient past 15s timeout', !p.ambient && noErr(p), JSON.stringify(p.errors));
    await sleep(17000);
    p = await pg.eval('window.__glassProbe()');
    check('C', 'ambient appears ~15s after last input', p.ambient && noErr(p));
    await pg.close();
  }
  // C3: pointermove dismisses an active ambient + brightness restored
  {
    const pg = await newPage('dist/c.html');
    await sleep(18000);
    let p = await pg.eval('window.__glassProbe()');
    check('C', 'ambient active before dismiss', p.ambient);
    await pg.eval(`document.dispatchEvent(new Event('pointermove', { bubbles: true }))`);
    await sleep(500);
    p = await pg.eval('window.__glassProbe()');
    check('C', 'pointermove dismisses ambient', !p.ambient && noErr(p));
    check('C', 'dismiss restores brightness', p.cmds.some(c => c.event === 'displaySetLevel' && c.data && c.data.level === 1),
      JSON.stringify(p.cmds.slice(-4)));
    await pg.close();
  }
  // C4: keyup resets the idle timer
  {
    const pg = await newPage('dist/c.html');
    await sleep(10000);
    await pg.eval(`document.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }))`);
    await sleep(9000);
    let p = await pg.eval('window.__glassProbe()');
    check('C', 'keyup resets timer (hidden at t~20s)', !p.ambient && noErr(p));
    await sleep(9000);
    p = await pg.eval('window.__glassProbe()');
    check('C', 'ambient fires ~15s after keyup', p.ambient && noErr(p));
    await pg.close();
  }
}

/* ---------------- Group D: companion defaults ---------------- */

async function groupD() {
  writeFileSync(join(SCRATCH, 'dist', 'settings-d.html'),
    settingsHostHtml(DAEMON_CFG({ config: { weather_location: 'Paris', weather_units: 'metric' } })));
  const pg = await newPage('dist/settings-d.html', { reloadAfterSeed: false });
  const btn = (sel, text) =>
    `[...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
  const ls = k => pg.eval(`localStorage.getItem(${JSON.stringify(k)})`);
  const apply = d => pg.eval(`window.__glassySettingsTest.applyCompanionDefaults(${JSON.stringify(d)})`, true);

  // D1: fetch returns companion values through the stubbed daemon
  const fetched = await pg.eval(`window.__glassySettingsTest.fetchCompanionDefaults('ws://fake/')`, true);
  check('D', 'fetchCompanionDefaults returns Paris/metric', fetched && fetched.location === 'Paris' && fetched.units === 'metric',
    JSON.stringify(fetched));

  // seed a stale geocode cache so we can prove apply clears it
  await pg.eval(`localStorage.setItem('glassy.weather_location_cache', '{"stale":1}')`);

  // D2-D8: apply mirrors the effective values into localStorage (v0.3.11 fix —
  // the overlay cannot read companion config, so defaults alone MUST write)
  await apply({ location: 'Paris', units: 'metric' });
  await sleep(200);
  check('D', 'input pre-filled with companion location', (await pg.eval(`document.getElementById('location').value`)) === 'Paris');
  check('D', 'companion unit highlighted', await pg.eval(`${btn('#units button', 'Metric')}.classList.contains('active')`));
  check('D', 'location hint uses companion default',
    (await pg.eval(`document.getElementById('lochint').textContent`)) === 'Using the companion app default (Paris).');
  check('D', 'units hint uses companion default',
    (await pg.eval(`document.getElementById('unitshint').textContent`)) === 'Using the companion app default (Metric (°C)).');
  check('D', 'defaults alone mirror location with companion src',
    (await ls('glassy.weather_location')) === 'Paris' && (await ls('glassy.weather_location_src')) === 'companion');
  check('D', 'defaults alone mirror units with companion src (the °F fix)',
    (await ls('glassy.weather_units')) === 'metric' && (await ls('glassy.weather_units_src')) === 'companion');
  check('D', 'apply clears the geocode cache', (await ls('glassy.weather_location_cache')) === null);

  // D9-D11: an explicit device unit pick writes with device src; hint shows the override
  await pg.eval(`${btn('#units button', 'Imperial')}.click()`);
  await sleep(200);
  check('D', 'device unit pick stored with device src',
    (await ls('glassy.weather_units')) === 'imperial' && (await ls('glassy.weather_units_src')) === 'device');
  check('D', 'units hint shows device override',
    (await pg.eval(`document.getElementById('unitshint').textContent`)) ===
    'Companion default is Metric (°C); this device overrides it.');

  // D12-D13: a changed companion default refreshes the mirrored location but never clobbers the device units choice
  await apply({ location: 'Madrid', units: 'imperial' });
  await sleep(200);
  check('D', 'changed companion default refreshes mirrored location',
    (await ls('glassy.weather_location')) === 'Madrid' && (await ls('glassy.weather_location_src')) === 'companion');
  check('D', 'changed companion default does not clobber device units',
    (await ls('glassy.weather_units')) === 'imperial' && (await ls('glassy.weather_units_src')) === 'device' &&
    (await pg.eval(`document.getElementById('unitshint').textContent`)).includes('this device overrides it.'));

  // D14-D16: an explicit device location save writes with device src; a blank save falls back to the companion default
  await pg.eval(`{ const i = document.getElementById('location'); i.value = 'Berlin'; i.dispatchEvent(new Event('change', {bubbles:true})); }`);
  await sleep(200);
  check('D', 'explicit location save stored with device src',
    (await ls('glassy.weather_location')) === 'Berlin' && (await ls('glassy.weather_location_src')) === 'device' &&
    (await pg.eval(`document.getElementById('lochint').textContent`)) === 'Companion default is Madrid; this device overrides it.');
  await pg.eval(`{ const i = document.getElementById('location'); i.value = ''; i.dispatchEvent(new Event('change', {bubbles:true})); }`);
  await sleep(200);
  check('D', 'blank location save falls back to companion default',
    (await ls('glassy.weather_location')) === 'Madrid' && (await ls('glassy.weather_location_src')) === 'companion');

  // D17-D18: with no companion defaults at all, hints stay empty and a blank save removes the keys
  writeFileSync(join(SCRATCH, 'dist', 'settings-d2.html'), settingsHostHtml(DAEMON_CFG({ config: {} })));
  const pg2 = await newPage('dist/settings-d2.html', { reloadAfterSeed: false });
  const ls2 = k => pg2.eval(`localStorage.getItem(${JSON.stringify(k)})`);
  await pg2.eval(`localStorage.clear()`);
  await pg2.eval(`window.__glassySettingsTest.applyCompanionDefaults({})`, true);
  await sleep(200);
  check('D', 'no companion defaults: hints empty',
    (await pg2.eval(`document.getElementById('lochint').textContent`)) === '' &&
    (await pg2.eval(`document.getElementById('unitshint').textContent`)) === '');
  await pg2.eval(`{ const i = document.getElementById('location'); i.value = ''; i.dispatchEvent(new Event('change', {bubbles:true})); }`);
  await sleep(200);
  check('D', 'no companion defaults: blank save removes keys',
    (await ls2('glassy.weather_location')) === null && (await ls2('glassy.weather_location_src')) === null);

  // D19-D20: live companion change while the settings page is open refreshes hints
  await pg2.eval(`window.__glassySettingsTest.watchCompanionDefaults('ws://fake/', window.__glassySettingsTest.applyCompanionDefaults)`, true);
  await sleep(500);
  await pg2.eval(`window.__daemonPushConfigChanged('ambient_dim_level', '33')`);
  await sleep(800);
  check('D', 'live companion change: dim hint refreshes',
    (await pg2.eval(`document.getElementById('dimhint').textContent`)) === 'Using the companion app default (33%).');
  check('D', 'live companion change: mirrored with companion src',
    (await ls2('glassy.ambient_dim_level')) === '33' && (await ls2('glassy.ambient_dim_level_src')) === 'companion');

  const errs = await pg.eval(`window.__glassErrors.slice()`);
  const errs2 = await pg2.eval(`window.__glassErrors.slice()`);
  check('D', 'companion defaults: zero JS errors', errs.length === 0 && errs2.length === 0, JSON.stringify([...errs, ...errs2]));
  await pg.close(); await pg2.close();
}

/* ---------------- main ---------------- */

try {
  await launchBrowser();
  await groupA();
  await groupB();
  await groupC();
  await groupD();
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  failCount++;
} finally {
  try { cdp && cdp.ws.close(); } catch {}
  try { chromeProc && chromeProc.kill('SIGKILL'); } catch {}
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}

console.log(`\nvalidate: ${passCount} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
