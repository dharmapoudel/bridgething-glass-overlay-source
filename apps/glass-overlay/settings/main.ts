import { BridgethingClient } from '@bridgething/client';

const LS_KEY = 'glassy.ambient_idle_s';
const LS_LOC = 'glassy.weather_location';
const LS_LOC_CACHE = 'glassy.weather_location_cache';
const LS_UNITS = 'glassy.weather_units';
const LS_ENABLED = 'glassy.ambient_enabled';
const LS_DIM = 'glassy.ambient_dim_level';
const LS_LOC_SRC = 'glassy.weather_location_src';
const LS_UNITS_SRC = 'glassy.weather_units_src';
const LS_ENABLED_SRC = 'glassy.ambient_enabled_src';
const LS_DIM_SRC = 'glassy.ambient_dim_level_src';

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
    // The overlay is injected into this very document, and the storage event
    // never fires in the document that wrote the value — notify it manually.
    window.dispatchEvent(new StorageEvent('storage', { key: k }));
  } catch {
  }
}
function lsDel(k: string): void {
  try {
    localStorage.removeItem(k);
  } catch {
  }
}
const DEFAULT_S = 30;
const MIN_S = 15;
const MAX_S = 3600;

const IDLE_OPTS: Array<[number, string]> = [
  [15, '15s'],
  [30, '30s'],
  [60, '1m'],
  [120, '2m'],
  [300, '5m'],
];
const LS_IDLE_SRC = 'glassy.ambient_idle_s_src';

const LS_REFRESH = 'glassy.weather_refresh_s';
const LS_REFRESH_SRC = 'glassy.weather_refresh_s_src';
const REFRESH_DEFAULT_S = 1800;
const REFRESH_MIN_S = 300;
const REFRESH_MAX_S = 7200;
const REFRESH_OPTS: Array<[number, string]> = [
  [300, '5m'],
  [900, '15m'],
  [1800, '30m'],
  [3600, '1hr'],
  [7200, '2hr'],
];

const LS_FROST = 'glassy.glass_frost';
const LS_FROST_SRC = 'glassy.glass_frost_src';
const FROST_DEFAULT = 2;
const FROST_MIN = 0;
const FROST_MAX = 3;
const FROST_OPTS: Array<[number, string]> = [
  [0, 'Clear'],
  [1, 'Light'],
  [2, 'Frosted'],
  [3, 'Extra'],
];
const FROST_LABELS: Record<number, string> = { 0: 'Clear', 1: 'Light', 2: 'Frosted', 3: 'Extra' };
const FROST_MAP: Array<[number, number, number]> = [
  [0.1, 8, 6], // Clear
  [0.22, 16, 14], // Light
  [0.4, 32, 28], // Frosted
  [0.62, 50, 42], // Extra
];

let companionLocation: string | null = null;
let companionUnits: 'imperial' | 'metric' | null = null;
let companionEnabled: boolean | null = null;
let companionDim: number | null = null;
let companionIdle: number | null = null;
let companionRefresh: number | null = null;
let companionFrost: number | null = null;

function readSecs(): number {
  const raw = lsGet(LS_KEY);
  const s = raw == null ? NaN : Number(raw);
  if (Number.isFinite(s)) return Math.min(MAX_S, Math.max(MIN_S, s));
  return companionIdle ?? DEFAULT_S;
}

const idleTiles = document.getElementById('idle-tiles') as HTMLDivElement;
const idleHint = document.getElementById('idlehint') as HTMLParagraphElement;
const savedEl = document.getElementById('saved') as HTMLParagraphElement;
let savedTimer: ReturnType<typeof setTimeout> | undefined;

function flashSaved(msg: string): void {
  savedEl.textContent = msg;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    savedEl.textContent = '';
  }, 2000);
}

function idleLabel(s: number): string {
  return s < 60 ? `${s}s` : `${s / 60}m`;
}

function refreshIdleHint(): void {
  if (companionIdle !== null) {
    idleHint.textContent =
      lsGet(LS_IDLE_SRC) === 'device'
        ? `Companion default is ${idleLabel(companionIdle)}; this device overrides it.`
        : `Using the companion app default (${idleLabel(companionIdle)}).`;
  } else {
    idleHint.textContent = '';
  }
}

function renderIdleTiles(): void {
  const cur = readSecs();
  idleTiles.textContent = '';
  for (const [secs, label] of IDLE_OPTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile' + (secs === cur ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      lsSet(LS_KEY, String(secs));
      lsSet(LS_IDLE_SRC, 'device');
      renderIdleTiles();
      refreshIdleHint();
      flashSaved('Saved');
    });
    idleTiles.appendChild(b);
  }
}
renderIdleTiles();

(document.getElementById('reset-idle') as HTMLButtonElement).addEventListener('click', () => {
  lsDel(LS_KEY);
  lsDel(LS_IDLE_SRC);
  renderIdleTiles();
  refreshIdleHint();
  flashSaved('Reset');
});

function clampRefreshSecs(s: number): number {
  if (!Number.isFinite(s)) return REFRESH_DEFAULT_S;
  return Math.min(REFRESH_MAX_S, Math.max(REFRESH_MIN_S, Math.round(s)));
}
function readRefreshSecs(): number {
  const raw = lsGet(LS_REFRESH);
  const s = raw == null ? NaN : Number(raw);
  if (Number.isFinite(s)) return clampRefreshSecs(s);
  return companionRefresh ?? REFRESH_DEFAULT_S;
}

const refreshTiles = document.getElementById('refresh-tiles') as HTMLDivElement;
const refreshHint = document.getElementById('refreshhint') as HTMLParagraphElement;

function refreshLabel(s: number): string {
  return s < 3600 ? `${s / 60}m` : `${s / 3600}hr`;
}

function refreshRefreshHint(): void {
  if (companionRefresh !== null) {
    refreshHint.textContent =
      lsGet(LS_REFRESH_SRC) === 'device'
        ? `Companion default is ${refreshLabel(companionRefresh)}; this device overrides it.`
        : `Using the companion app default (${refreshLabel(companionRefresh)}).`;
  } else {
    refreshHint.textContent = '';
  }
}

function renderRefreshTiles(): void {
  const cur = readRefreshSecs();
  refreshTiles.textContent = '';
  for (const [secs, label] of REFRESH_OPTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile' + (secs === cur ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      lsSet(LS_REFRESH, String(secs));
      lsSet(LS_REFRESH_SRC, 'device');
      renderRefreshTiles();
      refreshRefreshHint();
      flashSaved('Saved');
    });
    refreshTiles.appendChild(b);
  }
}
renderRefreshTiles();
refreshRefreshHint();

(document.getElementById('reset-refresh') as HTMLButtonElement).addEventListener('click', () => {
  lsDel(LS_REFRESH);
  lsDel(LS_REFRESH_SRC);
  renderRefreshTiles();
  refreshRefreshHint();
  flashSaved('Reset');
});

function clampFrost(n: number): number {
  if (!Number.isFinite(n)) return FROST_DEFAULT;
  return Math.min(FROST_MAX, Math.max(FROST_MIN, Math.round(n)));
}
function readFrost(): number {
  const raw = lsGet(LS_FROST);
  const n = raw == null ? NaN : Number(raw);
  if (Number.isFinite(n)) return clampFrost(n);
  return companionFrost ?? FROST_DEFAULT;
}

const frostTiles = document.getElementById('frost-tiles') as HTMLDivElement;
const frostHint = document.getElementById('frosthint') as HTMLParagraphElement;

function refreshFrostHint(): void {
  if (companionFrost !== null) {
    frostHint.textContent =
      lsGet(LS_FROST_SRC) === 'device'
        ? `Companion default is ${FROST_LABELS[companionFrost]}; this device overrides it.`
        : `Using the companion app default (${FROST_LABELS[companionFrost]}).`;
  } else {
    frostHint.textContent = '';
  }
}

const frostPreviewCard = document.getElementById('frost-preview-card') as HTMLDivElement;

function renderFrostPreview(): void {
  const cur = readFrost();
  const [tint, blurCard] = FROST_MAP[cur];
  // Same glass recipe as the overlay .glass-card: tinted translucent fill,
  // backdrop blur + saturate, hairline border, specular top sheen.
  frostPreviewCard.style.background = `rgba(20, 22, 28, ${tint})`;
  frostPreviewCard.style.backdropFilter = `blur(${blurCard}px) saturate(1.8)`;
  (frostPreviewCard.style as any).webkitBackdropFilter = `blur(${blurCard}px) saturate(1.8)`;
  frostPreviewCard.style.border = '1px solid rgba(255, 255, 255, 0.28)';
  frostPreviewCard.style.boxShadow = 'inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 8px 24px rgba(0, 0, 0, 0.25)';
}

function renderFrostTiles(): void {
  const cur = readFrost();
  frostTiles.textContent = '';
  for (const [val, label] of FROST_OPTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile' + (val === cur ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      lsSet(LS_FROST, String(val));
      lsSet(LS_FROST_SRC, 'device');
      renderFrostTiles();
      renderFrostPreview();
      refreshFrostHint();
      flashSaved('Saved');
    });
    frostTiles.appendChild(b);
  }
}
renderFrostTiles();
renderFrostPreview();
refreshFrostHint();

(document.getElementById('reset-frost') as HTMLButtonElement).addEventListener('click', () => {
  lsDel(LS_FROST);
  lsDel(LS_FROST_SRC);
  renderFrostTiles();
  renderFrostPreview();
  refreshFrostHint();
  flashSaved('Reset');
});

export type CompanionDefaults = {
  location: string | null;
  units: 'imperial' | 'metric' | null;
  enabled: boolean | null;
  dimLevel: number | null;
  idleTimeout: number | null;
  refresh: number | null;
  frost: number | null;
};

declare global {
  interface Window {
    __glassySettingsTest?: {
      fetchCompanionDefaults: (wsUrl: string) => Promise<CompanionDefaults>;
      applyCompanionDefaults: (d: CompanionDefaults) => void;
      watchCompanionDefaults: (wsUrl: string, onUpdate: (d: CompanionDefaults) => void) => () => void;
    };
  }
}

export async function fetchCompanionDefaults(wsUrl: string): Promise<CompanionDefaults> {
  const client = new BridgethingClient({ url: wsUrl, reconnect: false });
  try {
    return await readCompanionEntries(client);
  } finally {
    client.close();
  }
}

async function readCompanionEntries(client: BridgethingClient): Promise<CompanionDefaults> {
  const out: CompanionDefaults = { location: null, units: null, enabled: null, dimLevel: null, idleTimeout: null, refresh: null, frost: null };
  try {
    const get = async (key: string): Promise<string | null> => {
      try {
        const r = await client.config.get({ key }, { timeoutMs: 2500 });
        return r.ok ? r.response.value : null;
      } catch {
        return null;
      }
    };
    const [loc, units, enabled, dim, idle, refresh, frost] = await Promise.all([
      get('weather_location'),
      get('weather_units'),
      get('ambient_enabled'),
      get('ambient_dim_level'),
      get('ambient_idle_s'),
      get('weather_refresh_s'),
      get('glass_frost'),
    ]);
    if (loc) out.location = loc;
    if (units === 'imperial' || units === 'metric') out.units = units;
    if (enabled === 'true') out.enabled = true;
    else if (enabled === 'false') out.enabled = false;
    const dimNum = dim == null ? NaN : Number(dim);
    if (Number.isFinite(dimNum)) out.dimLevel = Math.min(100, Math.max(5, dimNum));
    const idleNum = idle == null ? NaN : Number(idle);
    if (Number.isFinite(idleNum)) out.idleTimeout = Math.min(MAX_S, Math.max(MIN_S, idleNum));
    const refreshNum = refresh == null ? NaN : Number(refresh);
    if (Number.isFinite(refreshNum)) out.refresh = Math.min(REFRESH_MAX_S, Math.max(REFRESH_MIN_S, Math.round(refreshNum)));
    const frostNum = frost == null ? NaN : Number(frost);
    if (Number.isFinite(frostNum)) out.frost = Math.min(FROST_MAX, Math.max(FROST_MIN, Math.round(frostNum)));
  } catch {
  }
  return out;
}

export function watchCompanionDefaults(wsUrl: string, onUpdate: (d: CompanionDefaults) => void): () => void {
  const client = new BridgethingClient({ url: wsUrl });
  let stopped = false;
  readCompanionEntries(client).then(
    d => {
      if (!stopped) onUpdate(d);
    },
    () => {},
  );
  let off: () => void = () => {};
  try {
    off = client.config.onChanged(() => {
      if (stopped) return;
      readCompanionEntries(client).then(onUpdate, () => {});
    });
  } catch {
  }
  return () => {
    stopped = true;
    off();
    client.close();
  };
}

export function applyCompanionDefaults(d: CompanionDefaults): void {
  companionLocation = d.location;
  companionUnits = d.units;
  companionEnabled = d.enabled;
  companionDim = d.dimLevel;
  companionIdle = d.idleTimeout;
  companionRefresh = d.refresh;
  companionFrost = d.frost;
  if (companionLocation && lsGet(LS_LOC_SRC) !== 'device') {
    lsSet(LS_LOC, companionLocation);
    lsSet(LS_LOC_SRC, 'companion');
    lsDel(LS_LOC_CACHE);
  }
  if (companionUnits && lsGet(LS_UNITS_SRC) !== 'device') {
    lsSet(LS_UNITS, companionUnits);
    lsSet(LS_UNITS_SRC, 'companion');
  }
  if (companionEnabled !== null && lsGet(LS_ENABLED_SRC) !== 'device') {
    lsSet(LS_ENABLED, String(companionEnabled));
    lsSet(LS_ENABLED_SRC, 'companion');
  }
  if (companionDim !== null && lsGet(LS_DIM_SRC) !== 'device') {
    lsSet(LS_DIM, String(companionDim));
    lsSet(LS_DIM_SRC, 'companion');
  }
  if (companionIdle !== null && lsGet(LS_IDLE_SRC) !== 'device') {
    lsSet(LS_KEY, String(companionIdle));
    lsSet(LS_IDLE_SRC, 'companion');
  }
  if (companionRefresh !== null && lsGet(LS_REFRESH_SRC) !== 'device') {
    lsSet(LS_REFRESH, String(companionRefresh));
    lsSet(LS_REFRESH_SRC, 'companion');
  }
  if (companionFrost !== null && lsGet(LS_FROST_SRC) !== 'device') {
    lsSet(LS_FROST, String(companionFrost));
    lsSet(LS_FROST_SRC, 'companion');
    renderFrostTiles();
    renderFrostPreview();
    refreshFrostHint();
  }
  if (!locTouched) locInput.value = lsGet(LS_LOC) || '';
  refreshLocHint();
  renderUnits();
  refreshUnitsHint();
  renderScreensaver();
  refreshScreensaverHint();
  renderIdleTiles();
  refreshIdleHint();
  renderRefreshTiles();
  refreshRefreshHint();
  renderFrostTiles();
  refreshFrostHint();
  dimInput.value = String(readDim());
  dimVal.textContent = `${readDim()}%`;
  refreshDimHint();
}

if (location.host) {
  watchCompanionDefaults(`ws://${location.host}/`, applyCompanionDefaults);
}

window.__glassySettingsTest = { fetchCompanionDefaults, applyCompanionDefaults, watchCompanionDefaults };

const locInput = document.getElementById('location') as HTMLInputElement;
const locHint = document.getElementById('lochint') as HTMLParagraphElement;
let locTouched = false;
locInput.addEventListener('input', () => {
  locTouched = true;
});
locInput.value = lsGet(LS_LOC) || '';
function refreshLocHint(): void {
  if (companionLocation) {
    locHint.textContent =
      lsGet(LS_LOC_SRC) === 'device'
        ? `Companion default is ${companionLocation}; this device overrides it.`
        : `Using the companion app default (${companionLocation}).`;
  } else {
    locHint.textContent = '';
  }
}
locInput.addEventListener('change', () => {
  const v = locInput.value.trim();
  const effective = v || companionLocation || '';
  if (effective) {
    lsSet(LS_LOC, effective);
    lsSet(LS_LOC_SRC, v ? 'device' : 'companion');
  } else {
    lsDel(LS_LOC);
    lsDel(LS_LOC_SRC);
  }
  lsDel(LS_LOC_CACHE);
  locTouched = false;
  refreshLocHint();
  flashSaved('Saved');
});
(document.getElementById('reset-location') as HTMLButtonElement).addEventListener('click', () => {
  lsDel(LS_LOC);
  lsDel(LS_LOC_SRC);
  lsDel(LS_LOC_CACHE);
  locInput.value = '';
  locTouched = false;
  refreshLocHint();
  flashSaved('Reset');
});

const unitsGrid = document.getElementById('units') as HTMLDivElement;
const UNIT_OPTS: Array<['imperial' | 'metric', string]> = [
  ['imperial', 'Imperial'],
  ['metric', 'Metric'],
];
function readUnits(): 'imperial' | 'metric' {
  try {
    const raw = localStorage.getItem(LS_UNITS);
    if (raw === 'imperial' || raw === 'metric') return raw;
  } catch {
  }
  return companionUnits || 'imperial';
}
const unitHint = document.getElementById('unitshint') as HTMLParagraphElement;
function refreshUnitsHint(): void {
  if (companionUnits) {
    const label = companionUnits === 'metric' ? 'Metric (°C)' : 'Imperial (°F)';
    unitHint.textContent =
      lsGet(LS_UNITS_SRC) === 'device'
        ? `Companion default is ${label}; this device overrides it.`
        : `Using the companion app default (${label}).`;
  } else {
    unitHint.textContent = '';
  }
}
function renderUnits(): void {
  const cur = readUnits();
  unitsGrid.textContent = '';
  for (const [val, label] of UNIT_OPTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = val === cur ? 'active' : '';
    b.textContent = label;
    b.addEventListener('click', () => {
      lsSet(LS_UNITS, val);
      lsSet(LS_UNITS_SRC, 'device');
      renderUnits();
      refreshUnitsHint();
      flashSaved('Saved');
    });
    unitsGrid.appendChild(b);
  }
}
renderUnits();
(document.getElementById('reset-units') as HTMLButtonElement).addEventListener('click', () => {
  lsDel(LS_UNITS);
  lsDel(LS_UNITS_SRC);
  renderUnits();
  refreshUnitsHint();
  flashSaved('Reset');
});

const switchRow = document.getElementById('screenswitch') as HTMLButtonElement;
const switchLabel = document.getElementById('switchlabel') as HTMLSpanElement;
const screensaverHint = document.getElementById('screensaverhint') as HTMLParagraphElement;
function readEnabled(): boolean {
  const raw = lsGet(LS_ENABLED);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return companionEnabled ?? true;
}
function refreshScreensaverHint(): void {
  if (companionEnabled !== null) {
    const label = companionEnabled ? 'On' : 'Off';
    screensaverHint.textContent =
      lsGet(LS_ENABLED_SRC) === 'device'
        ? `Companion default is ${label}; this device overrides it.`
        : `Using the companion app default (${label}).`;
  } else {
    screensaverHint.textContent = '';
  }
}
function renderScreensaver(): void {
  const cur = readEnabled();
  switchRow.classList.toggle('on', cur);
  switchRow.setAttribute('aria-checked', String(cur));
  switchLabel.textContent = cur ? 'enabled' : 'disabled';
}
switchRow.addEventListener('click', () => {
  const next = !readEnabled();
  lsSet(LS_ENABLED, String(next));
  lsSet(LS_ENABLED_SRC, 'device');
  renderScreensaver();
  refreshScreensaverHint();
  flashSaved('Saved');
});
(document.getElementById('reset-screensaver') as HTMLButtonElement).addEventListener('click', () => {
  lsDel(LS_ENABLED);
  lsDel(LS_ENABLED_SRC);
  renderScreensaver();
  refreshScreensaverHint();
  flashSaved('Reset');
});
renderScreensaver();

const DIM_DEFAULT = 15;
const DIM_MIN = 5;
const DIM_MAX = 100;
const dimInput = document.getElementById('dim') as HTMLInputElement;
const dimVal = document.getElementById('dimval') as HTMLSpanElement;
const dimHint = document.getElementById('dimhint') as HTMLParagraphElement;
function clampDimInput(v: number): number {
  if (!Number.isFinite(v)) return DIM_DEFAULT;
  return Math.min(DIM_MAX, Math.max(DIM_MIN, Math.round(v / 5) * 5));
}
function readDim(): number {
  const raw = lsGet(LS_DIM);
  const v = raw == null ? NaN : Number(raw);
  if (Number.isFinite(v)) return Math.min(DIM_MAX, Math.max(DIM_MIN, v));
  return companionDim ?? DIM_DEFAULT;
}
function refreshDimHint(): void {
  if (companionDim !== null) {
    dimHint.textContent =
      lsGet(LS_DIM_SRC) === 'device'
        ? `Companion default is ${companionDim}%; this device overrides it.`
        : `Using the companion app default (${companionDim}%).`;
  } else {
    dimHint.textContent = '';
  }
}
dimInput.value = String(readDim());
dimVal.textContent = `${readDim()}%`;
dimInput.addEventListener('input', () => {
  dimVal.textContent = `${dimInput.value}%`;
});
dimInput.addEventListener('change', () => {
  const pct = clampDimInput(Number(dimInput.value));
  lsSet(LS_DIM, String(pct));
  lsSet(LS_DIM_SRC, 'device');
  dimInput.value = String(pct);
  dimVal.textContent = `${pct}%`;
  refreshDimHint();
  flashSaved('Saved');
});
(document.getElementById('reset-dim') as HTMLButtonElement).addEventListener('click', () => {
  lsDel(LS_DIM);
  lsDel(LS_DIM_SRC);
  dimInput.value = String(readDim());
  refreshDimHint();
  flashSaved('Reset');
});

// The Car Thing knob arrives as horizontal wheel events; translate them into
// vertical scroll so the knob scrolls the settings page.
window.addEventListener('wheel', e => {
  const ax = Math.abs(e.deltaX), ay = Math.abs(e.deltaY);
  if (ax === 0 && ay === 0) return;
  if (ax >= ay) {
    e.preventDefault();
    window.scrollBy(0, e.deltaX);
  }
}, { passive: false });
