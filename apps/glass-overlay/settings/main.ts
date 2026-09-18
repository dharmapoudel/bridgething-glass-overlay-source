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

let companionLocation: string | null = null;
let companionUnits: 'imperial' | 'metric' | null = null;
let companionEnabled: boolean | null = null;
let companionDim: number | null = null;
let companionIdle: number | null = null;

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

export type CompanionDefaults = {
  location: string | null;
  units: 'imperial' | 'metric' | null;
  enabled: boolean | null;
  dimLevel: number | null;
  idleTimeout: number | null;
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
  const out: CompanionDefaults = { location: null, units: null, enabled: null, dimLevel: null, idleTimeout: null };
  try {
    const get = async (key: string): Promise<string | null> => {
      try {
        const r = await client.config.get({ key }, { timeoutMs: 2500 });
        return r.ok ? r.response.value : null;
      } catch {
        return null;
      }
    };
    const [loc, units, enabled, dim, idle] = await Promise.all([
      get('weather_location'),
      get('weather_units'),
      get('ambient_enabled'),
      get('ambient_dim_level'),
      get('ambient_idle_s'),
    ]);
    if (loc) out.location = loc;
    if (units === 'imperial' || units === 'metric') out.units = units;
    if (enabled === 'true') out.enabled = true;
    else if (enabled === 'false') out.enabled = false;
    const dimNum = dim == null ? NaN : Number(dim);
    if (Number.isFinite(dimNum)) out.dimLevel = Math.min(100, Math.max(5, dimNum));
    const idleNum = idle == null ? NaN : Number(idle);
    if (Number.isFinite(idleNum)) out.idleTimeout = Math.min(MAX_S, Math.max(MIN_S, idleNum));
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
  if (!locTouched) locInput.value = lsGet(LS_LOC) || '';
  refreshLocHint();
  renderUnits();
  refreshUnitsHint();
  renderScreensaver();
  refreshScreensaverHint();
  renderIdleTiles();
  refreshIdleHint();
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
