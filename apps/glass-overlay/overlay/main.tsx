import type {
  BluetoothPin,
  BrightnessState,
  Notification,
  PeerSnapshotMap,
  PhoneCall,
  PlayerState,
  VolumeChanged,
} from '@bridgething/client';
import { BridgethingClient } from '@bridgething/client';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import css from './style.css?inline';

type OverlaySurfaces = {
  notifications: boolean;
  call: boolean;
  pairing: boolean;
  connection: boolean;
  volume: boolean;
  voice: boolean;
};

type OverlayConfig = { origin: string; url?: string; surfaces: OverlaySurfaces; ambientIdleMs?: number };

declare global {
  interface Window {
    __bridgethingOverlay?: OverlayConfig;
    __bridgethingOverlayMounted?: boolean;
  }
}

let companionCfg: Record<string, string> = {};
let companionCfgVersion = 0;
const companionCfgSubs = new Set<() => void>();
function bumpCompanionCfg(): void {
  companionCfgVersion++;
  for (const f of companionCfgSubs) {
    try {
      f();
    } catch {
    }
  }
}
function useCompanionCfg(): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick(t => t + 1);
    companionCfgSubs.add(f);
    return () => {
      companionCfgSubs.delete(f);
    };
  }, []);
  return companionCfgVersion;
}
async function pullCompanionCfg(client: BridgethingClient): Promise<void> {
  try {
    const res = await client.config.list({ timeoutMs: 4000 });
    if (res.ok) {
      const next: Record<string, string> = {};
      for (const e of res.response.entries) {
        if (typeof e.key === 'string' && typeof e.value === 'string') next[e.key] = e.value;
      }
      companionCfg = next;
      bumpCompanionCfg();
    }
  } catch {
  }
}
function syncCompanionCfg(client: BridgethingClient): void {
  try {
    client.on(ev => {
      if (ev.type === 'open') pullCompanionCfg(client).catch(() => {});
    });
  } catch {
  }
  try {
    client.config.onChanged(msg => {
      if (!msg || typeof msg.key !== 'string') return;
      if (msg.value == null) delete companionCfg[msg.key];
      else companionCfg[msg.key] = msg.value;
      bumpCompanionCfg();
    });
  } catch {
  }
}

const TOAST_TTL_MS = 5_000;
const MAX_TOASTS = 3;
const VOLUME_TTL_MS = 1_500;
const CONNECTION_SHOW_DELAY_MS = 3_000;

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
  }
}

function useLatest<T>(
  subscribe: (emit: (value: T | null) => void) => () => void,
  ttl?: number,
  deps: unknown[] = [],
): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(next => {
      clearTimeout(timer);
      setValue(next);
      if (next !== null && ttl !== undefined) timer = setTimeout(() => setValue(null), ttl);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, deps);
  return value;
}

function timeAgo(tsUnixS: number | null | undefined): string {
  if (!tsUnixS) return 'now';
  const s = Math.max(0, Math.round(Date.now() / 1000 - tsUnixS));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function Toasts({ client }: { client: BridgethingClient }) {
  const [live, setLive] = useState<Notification[]>([]);

  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const drop = (id: string) => {
      clearTimeout(timers.get(id));
      timers.delete(id);
      setLive(prev => prev.filter(n => n.id !== id));
    };
    const post = (n: Notification) => {
      if (n.flags?.silent) return;
      clearTimeout(timers.get(n.id));
      timers.set(
        n.id,
        setTimeout(() => drop(n.id), TOAST_TTL_MS),
      );
      setLive(prev => [...prev.filter(other => other.id !== n.id), n].slice(-MAX_TOASTS));
    };
    const offs = [
      client.notifications.onPosted(post),
      client.notifications.onUpdated(post),
      client.notifications.onRemoved(removed => drop(removed.id)),
    ];
    return () => {
      timers.forEach(clearTimeout);
      offs.forEach(off => off());
    };
  }, [client]);

  return (
    <div className="pointer-events-none absolute top-4 right-4 flex w-[340px] flex-col items-stretch gap-2.5">
      {live.map(n => (
        <div key={n.id} className="glass-card animate-toast-in rounded-2xl px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <div className="truncate text-[10px] font-semibold tracking-[0.18em] text-white/50 uppercase">
              {n.app?.displayName ?? n.app?.bundleId ?? ''}
            </div>
            <div className="shrink-0 text-[10px] text-white/35">{timeAgo(n.timestampUnixS)}</div>
          </div>
          {n.title ? <div className="mt-0.5 truncate text-[15px] font-semibold text-white">{n.title}</div> : null}
          {n.message ?? n.subtitle ? (
            <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-white/75">{n.message ?? n.subtitle}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CallCard({ client, onDismissible }: { client: BridgethingClient; onDismissible: Dismissible }) {
  const [call, setCall] = useState<PhoneCall | null>(null);

  useEffect(() => {
    const offs = [
      client.phone.onCallStarted(setCall),
      client.phone.onCallUpdated(next => setCall(prev => (prev === null || prev.callId === next.callId ? next : prev))),
      client.phone.onCallEnded(ended => setCall(prev => (prev?.callId === ended.callId ? null : prev))),
    ];
    return () => offs.forEach(off => off());
  }, [client]);

  useEffect(() => (call ? onDismissible(() => setCall(null)) : undefined), [call, onDismissible]);

  if (!call) return null;
  const name = call.displayName || call.remoteId || 'unknown caller';
  const incoming = call.direction === 'incoming' && (call.status === 'ringing' || call.status === 'connecting');
  const active = call.status === 'active';
  const statusLabel = incoming ? 'incoming call' : active ? 'on call' : call.status;

  return (
    <div className="pointer-events-auto absolute inset-0 grid place-items-center bg-black/60">
      <div className="glass-card animate-call-in w-[380px] rounded-3xl px-8 py-7 text-center">
        <div className="mx-auto mb-4 grid size-14 place-items-center rounded-full bg-emerald-500/20">
          <div className={`size-4 rounded-full bg-emerald-400 ${active ? '' : 'animate-ping-slow'}`} />
        </div>
        <div className="text-[11px] font-semibold tracking-[0.22em] text-white/50 uppercase">{statusLabel}</div>
        <div className="mt-1 truncate text-[38px] leading-tight font-bold text-white">{name}</div>
        {call.remoteId && call.displayName ? <div className="mt-1 text-sm text-white/55">{call.remoteId}</div> : null}
        <div className="mt-6 flex items-center justify-center gap-10">
          {incoming ? (
            <>
              <button
                className="grid size-16 place-items-center rounded-full bg-red-500 pressable text-2xl text-white transition"
                onClick={() => client.phone.decline({ callId: call.callId }).catch(() => {})}
                aria-label="decline"
              >
                ✕
              </button>
              <button
                className="grid size-16 place-items-center rounded-full bg-emerald-500 pressable text-2xl text-white transition"
                onClick={() => client.phone.answer({ callId: call.callId }).catch(() => {})}
                aria-label="accept"
              >
                ✓
              </button>
            </>
          ) : (
            <button
              className="grid size-16 place-items-center rounded-full bg-red-500 pressable text-2xl text-white transition"
              onClick={() => client.phone.end({ callId: call.callId }).catch(() => {})}
              aria-label="end call"
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PairingModal({ client, onDismissible }: { client: BridgethingClient; onDismissible: Dismissible }) {
  const [pin, setPin] = useState<BluetoothPin | null>(null);

  useEffect(() => {
    const offs = [client.bluetooth.onPin(setPin), client.bluetooth.onPairingResult(() => setPin(null))];
    return () => offs.forEach(off => off());
  }, [client]);

  useEffect(() => (pin ? onDismissible(() => setPin(null)) : undefined), [pin, onDismissible]);

  if (!pin) return null;
  return (
    <div className="pointer-events-auto absolute inset-0 grid place-items-center bg-black/70 text-center">
      <div className="glass-card animate-call-in rounded-3xl px-12 py-9">
        <div className="text-[13px] tracking-wide text-white/60">enter this pin on your phone</div>
        <div className="my-4 font-mono text-[52px] font-bold tracking-[0.12em] text-white">{pin.pin}</div>
        <div className="text-xs text-white/45">{pin.name || pin.mac}</div>
      </div>
    </div>
  );
}

function ConnectionBanner({ client }: { client: BridgethingClient }) {
  const [away, setAway] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = client.peer.onSnapshot((snapshot: PeerSnapshotMap) => {
      const peers = Object.values(snapshot);
      const paired = peers.some(p => p.paired);
      const useful = peers.some(p => p.iap2 === 'identified' || p.companion.type === 'connected');
      if (paired && !useful) {
        timer ??= setTimeout(() => setAway(true), CONNECTION_SHOW_DELAY_MS);
      } else {
        clearTimeout(timer);
        timer = undefined;
        setAway(false);
      }
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [client]);

  if (!away) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center"><div className="glass-pill animate-fade-in pointer-events-auto rounded-full px-5 py-2.5 text-sm text-white">
      <span className="mr-2 inline-block size-2 rounded-full bg-red-400" />
      phone disconnected
    </div>
    </div>
  );
}

function VolumeBar({ client }: { client: BridgethingClient }) {
  const volume = useLatest<VolumeChanged>(emit => client.audio.onVolumeChanged(emit), VOLUME_TTL_MS, [client]);
  if (!volume) return null;
  const percent = Math.round(Math.min(1, Math.max(0, volume.level)) * 100);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center"><div className="glass-card animate-fade-in w-[440px] rounded-2xl px-5 py-3.5">
      <div className="mb-2 flex items-baseline justify-between text-[13px] text-white/70">
        <span>{volume.muted ? 'muted' : 'volume'}</span>
        <span className={`font-semibold ${volume.muted ? 'text-red-400' : 'text-white'}`}>
          {volume.muted ? 'muted' : `${percent}%`}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/15">
        <div
          className={`h-full rounded-full transition-[width] duration-150 ${volume.muted ? 'bg-red-400' : 'bg-cyan-400'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
    </div>
  );
}

type VoicePhase = 'idle' | 'listening' | 'thinking' | 'done' | 'failed';

function VoicePill({ client }: { client: BridgethingClient }) {
  const [phase, setPhase] = useState<VoicePhase>('idle');

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const clearAll = () => timers.forEach(clearTimeout);
    const settle = (p: 'done' | 'failed') => {
      clearAll();
      setPhase(p);
      timers.push(setTimeout(() => setPhase('idle'), 1_800));
    };
    const offs = [
      client.voice.onActivity(act => {
        if (act.phase === 'listening' || act.phase === 'thinking') {
          clearAll();
          setPhase(act.phase);
        } else if (act.phase === 'done') settle('done');
        else if (act.phase === 'failed') settle('failed');
      }),
    ];
    return () => {
      clearAll();
      offs.forEach(off => off());
    };
  }, [client]);

  if (phase === 'idle') return null;
  const label =
    phase === 'listening' ? 'listening…' : phase === 'thinking' ? 'thinking…' : phase === 'done' ? 'done' : 'sorry';
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-28 flex justify-center"><div className="glass-pill animate-fade-in flex items-center gap-2.5 rounded-full px-5 py-2.5 text-sm text-white">
      <div
        className={`size-3.5 rounded-full ${phase === 'listening' ? 'animate-pulse bg-cyan-400' : phase === 'thinking' ? 'animate-spin-slow bg-violet-400' : phase === 'done' ? 'bg-emerald-400' : 'bg-red-400'}`}
      />
      {label}
    </div>
    </div>
  );
}

const AMBIENT_IDLE_MIN_S = 15;
const AMBIENT_IDLE_MAX_S = 3600;
const AMBIENT_IDLE_DEFAULT_S = 30;

function clampIdleSecs(s: number): number {
  return Math.min(AMBIENT_IDLE_MAX_S, Math.max(AMBIENT_IDLE_MIN_S, s));
}

const AMBIENT_LS_KEY = 'glassy.ambient_idle_s';
const LS_AMBIENT_ENABLED = 'glassy.ambient_enabled';

function readAmbientEnabled(): boolean {
  const raw = lsGet(LS_AMBIENT_ENABLED);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const injected = companionCfg.ambient_enabled;
  if (injected === 'true') return true;
  if (injected === 'false') return false;
  return true;
}

function useAmbientEnabled(): boolean {
  useCompanionCfg();
  const [enabled, setEnabled] = useState(() => readAmbientEnabled());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== LS_AMBIENT_ENABLED) return;
      setEnabled(readAmbientEnabled());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => {
    setEnabled(readAmbientEnabled());
  }, [companionCfgVersion]);
  return enabled;
}

function ambientIdleMs(): number {
  const rawLs = lsGet(AMBIENT_LS_KEY);
  const secsLs = rawLs == null ? NaN : Number(rawLs);
  if (Number.isFinite(secsLs)) return clampIdleSecs(secsLs) * 1000;
  const raw = companionCfg.ambient_idle_s;
  const secs = raw == null ? NaN : Number(raw);
  return (Number.isFinite(secs) ? clampIdleSecs(secs) : AMBIENT_IDLE_DEFAULT_S) * 1000;
}

function useAmbientIdleMs(): number {
  useCompanionCfg();
  const [ms, setMs] = useState(() => ambientIdleMs());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== AMBIENT_LS_KEY) return;
      setMs(ambientIdleMs());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => {
    setMs(ambientIdleMs());
  }, [companionCfgVersion]);
  return ms;
}
const LS_DIM_LEVEL = 'glassy.ambient_dim_level';
const DIM_DEFAULT_PCT = 15;
const DIM_MIN_PCT = 5;
const DIM_MAX_PCT = 100;

function readDimLevel(): number {
  const pct = (raw: string | null | undefined): number => {
    const v = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(v)) return NaN;
    return Math.min(DIM_MAX_PCT, Math.max(DIM_MIN_PCT, v)) / 100;
  };
  const ls = pct(lsGet(LS_DIM_LEVEL));
  if (Number.isFinite(ls)) return ls;
  const injected = pct(companionCfg.ambient_dim_level);
  if (Number.isFinite(injected)) return injected;
  return DIM_DEFAULT_PCT / 100;
}
const BURNIN_SHIFT_MS = (() => {
  const v = Number(lsGet('glassy.burnin_shift_ms'));
  if (Number.isFinite(v) && v >= 1000) return v;
  return 60_000;
})();
const BURNIN_STEPS = [
  { x: 0, y: 0 },
  { x: 5, y: 3 },
  { x: -4, y: 5 },
  { x: -5, y: -3 },
  { x: 4, y: -5 },
];
const LS_WEATHER_REFRESH_S = 'glassy.weather_refresh_s';
const WEATHER_REFRESH_DEFAULT_S = 1800;
const WEATHER_REFRESH_MIN_S = 300;
const WEATHER_REFRESH_MAX_S = 7200;

function clampRefreshSecs(secs: number): number {
  if (!Number.isFinite(secs)) return WEATHER_REFRESH_DEFAULT_S;
  return Math.min(WEATHER_REFRESH_MAX_S, Math.max(WEATHER_REFRESH_MIN_S, Math.round(secs)));
}

function weatherRefreshMs(): number {
  const rawLs = lsGet(LS_WEATHER_REFRESH_S);
  const secsLs = rawLs == null ? NaN : Number(rawLs);
  if (Number.isFinite(secsLs)) return clampRefreshSecs(secsLs) * 1000;
  const raw = companionCfg.weather_refresh_s;
  const secs = raw == null ? NaN : Number(raw);
  return clampRefreshSecs(secs) * 1000;
}

function useWeatherRefreshMs(): number {
  useCompanionCfg();
  const [ms, setMs] = useState(() => weatherRefreshMs());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== LS_WEATHER_REFRESH_S) return;
      setMs(weatherRefreshMs());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => {
    setMs(weatherRefreshMs());
  }, [companionCfgVersion]);
  return ms;
}

function useIdle(timeoutMs: number): boolean {
  const [idle, setIdle] = useState(false);
  const timeoutRef = useRef(timeoutMs);
  const armRef = useRef<(ms: number) => void>(() => {});
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), ms);
    };
    armRef.current = arm;
    const poke = () => arm(timeoutRef.current);
    const events = [
      'keydown',
      'keyup',
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'touchstart',
      'touchmove',
      'touchend',
      'touchcancel',
      'wheel',
    ] as const;
    for (const e of events) document.addEventListener(e, poke, { capture: true, passive: true });
    poke();
    return () => {
      clearTimeout(timer);
      for (const e of events) document.removeEventListener(e, poke, { capture: true });
    };
  }, []);
  useEffect(() => {
    if (timeoutMs !== timeoutRef.current) {
      timeoutRef.current = timeoutMs;
      armRef.current(timeoutMs);
    }
  }, [timeoutMs]);
  return idle;
}

function resolveTimeZone(info: {
  tzIana: string | null;
  utcOffsetMinutes: number | null;
  dstOffsetMinutes: number | null;
}): string | undefined {
  if (info.tzIana) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: info.tzIana });
      return info.tzIana;
    } catch {
    }
  }
  const offMin = (info.utcOffsetMinutes ?? 0) + (info.dstOffsetMinutes ?? 0);
  if (offMin % 60 !== 0) return undefined;
  const hours = offMin / 60;
  if (hours === 0) return 'Etc/UTC';
  return `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
}

function weatherLabel(code: number | null | undefined): string {
  if (code == null) return '';
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Partly cloudy';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code === 85 || code === 86) return 'Snow showers';
  if (code >= 95) return 'Thunderstorm';
  return '';
}

type Units = 'imperial' | 'metric';
const LS_UNITS = 'glassy.weather_units';
const LS_LOC = 'glassy.weather_location';
const LS_LOC_CACHE = 'glassy.weather_location_cache';

function readUnits(): Units {
  const ls = lsGet(LS_UNITS);
  if (ls === 'metric' || ls === 'imperial') return ls;
  return companionCfg.weather_units === 'metric' ? 'metric' : 'imperial';
}

type LatLon = { lat: number; lon: number };

function parseLatLon(s: string): LatLon | null {
  const m = s.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function decodeBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (Array.isArray(body)) return new TextDecoder().decode(new Uint8Array(body as number[]));
  return '';
}

async function geocode(client: BridgethingClient, q: string): Promise<LatLon | null> {
  try {
    const raw = lsGet(LS_LOC_CACHE);
    if (raw) {
      const c = JSON.parse(raw) as { q?: unknown; lat?: unknown; lon?: unknown };
      if (c.q === q && typeof c.lat === 'number' && typeof c.lon === 'number') {
        return { lat: c.lat, lon: c.lon };
      }
    }
  } catch {
  }
  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}` +
    `&count=1&language=en&format=json`;
  try {
    const res = await client.net.fetch(
      { request: { url, method: 'GET', headers: [], body: null, timeoutMs: 15_000, redirect: 'follow' } },
      { timeoutMs: 20_000 },
    );
    if (!res.ok || res.response.response.status !== 200) return null;
    const json = JSON.parse(decodeBody(res.response.response.body));
    const r = json?.results?.[0];
    if (typeof r?.latitude === 'number' && typeof r?.longitude === 'number') {
      const ll = { lat: r.latitude, lon: r.longitude };
      lsSet(LS_LOC_CACHE, JSON.stringify({ q, ...ll }));
      return ll;
    }
  } catch {
  }
  return null;
}

const LS_COORDS_CACHE = 'glassy.weather_coords_cache';
const COORDS_TTL_MS = 6 * 3600_000;

async function resolveLocation(client: BridgethingClient): Promise<LatLon | null> {
  const q = (lsGet(LS_LOC) || companionCfg.weather_location || '').trim();
  if (!q) {
    try {
      const raw = lsGet(LS_COORDS_CACHE);
      if (raw) {
        const c = JSON.parse(raw) as { lat?: unknown; lon?: unknown; ts?: unknown };
        if (
          typeof c.lat === 'number' &&
          typeof c.lon === 'number' &&
          typeof c.ts === 'number' &&
          Date.now() - c.ts < COORDS_TTL_MS
        ) {
          return { lat: c.lat, lon: c.lon };
        }
      }
    } catch {
    }
    try {
      const pos = await client.geo.getOnce({ accuracy: 'coarse', maxAgeS: 900 }, { timeoutMs: 8_000 });
      if (pos.ok) {
        const ll = { lat: pos.response.position.lat, lon: pos.response.position.lon };
        lsSet(LS_COORDS_CACHE, JSON.stringify({ ...ll, ts: Date.now() }));
        return ll;
      }
    } catch {
    }
    return null;
  }
  return parseLatLon(q) ?? (await geocode(client, q));
}

type ForecastDay = { date: string; high: number; low: number; code: number | null };
type WeatherNow = {
  temp: number;
  label: string;
  humidity: number | null;
  wind: number | null;
  units: Units;
  code: number | null;
  isDay: boolean | null;
  days: ForecastDay[];
};

async function loadWeather(client: BridgethingClient): Promise<WeatherNow | null> {
  const units = readUnits();
  const ll = await resolveLocation(client);
  if (!ll) return null;
  const { lat, lon } = ll;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,is_day` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
    `&temperature_unit=${units === 'metric' ? 'celsius' : 'fahrenheit'}` +
    `&wind_speed_unit=${units === 'metric' ? 'kmh' : 'mph'}` +
    `&timezone=auto&forecast_days=5`;
  try {
    const res = await client.net.fetch(
      { request: { url, method: 'GET', headers: [], body: null, timeoutMs: 15_000, redirect: 'follow' } },
      { timeoutMs: 20_000 },
    );
    if (!res.ok || res.response.response.status !== 200) return null;
    const json = JSON.parse(decodeBody(res.response.response.body));
    const temp = json?.current?.temperature_2m;
    if (typeof temp !== 'number') return null;
    const code = json?.current?.weather_code;
    const humidity = json?.current?.relative_humidity_2m;
    const wind = json?.current?.wind_speed_10m;
    const times: string[] = Array.isArray(json?.daily?.time) ? json.daily.time : [];
    const highs: unknown[] = Array.isArray(json?.daily?.temperature_2m_max) ? json.daily.temperature_2m_max : [];
    const lows: unknown[] = Array.isArray(json?.daily?.temperature_2m_min) ? json.daily.temperature_2m_min : [];
    const codes: unknown[] = Array.isArray(json?.daily?.weather_code) ? json.daily.weather_code : [];
    const days: ForecastDay[] = times.slice(0, 5).map((d, i) => ({
      date: d,
      high: typeof highs[i] === 'number' ? Math.round(highs[i] as number) : Math.round(temp),
      low: typeof lows[i] === 'number' ? Math.round(lows[i] as number) : Math.round(temp),
      code: typeof codes[i] === 'number' ? (codes[i] as number) : null,
    }));
    return {
      temp: Math.round(temp),
      label: weatherLabel(typeof code === 'number' ? code : null),
      humidity: typeof humidity === 'number' ? Math.round(humidity) : null,
      wind: typeof wind === 'number' ? Math.round(wind) : null,
      units,
      code: typeof code === 'number' ? code : null,
      isDay: typeof json?.current?.is_day === 'number' ? json.current.is_day === 1 : null,
      days,
    };
  } catch {
    return null;
  }
}

function weatherCategory(code: number | null | undefined): string {
  if (code == null) return 'cloud';
  if (code === 0) return 'sun';
  if (code <= 3) return 'partly';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 95) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'rain';
}

const GLYPH_EMOJI: Record<string, string> = {
  sun: '☀️',
  moon: '🌙',
  partly: '⛅',
  cloud: '☁️',
  fog: '🌫️',
  rain: '🌧️',
  snow: '🌨️',
  storm: '⛈️',
};

function WeatherGlyph({
  code,
  size,
  night,
}: {
  code: number | null | undefined;
  size: number;
  night?: boolean;
}) {
  const cat = weatherCategory(code);
  const key = night && cat === 'sun' ? 'moon' : cat;
  return (
    <span style={{ fontSize: size, lineHeight: 1, opacity: 0.65 }} aria-hidden="true">
      {GLYPH_EMOJI[key] ?? '☁️'}
    </span>
  );
}

function playingTrack(state: PlayerState): { title: string; artist: string } | null {
  if (state.playback.state !== 'playing' || !state.track?.title) return null;
  return { title: state.track.title, artist: state.track.artist ?? '' };
}

// now-playing ticker: hard-trim the track text so long titles never push the
// ambient dashboard layout around; the CSS `truncate` stays as a fallback.
const NOW_PLAYING_MAX_CHARS = 20;

function truncateNowPlaying(text: string): string {
  const chars = [...text];
  return chars.length > NOW_PLAYING_MAX_CHARS ? chars.slice(0, NOW_PLAYING_MAX_CHARS).join('') + '\u2026' : text;
}

// Portrait detection (same as Radio Atlas / Calendar): the daemon pins the
// layout viewport at 800x480 and rotates the panel, so a viewport-size check
// never fires on-device. screen.orientation reports portrait-secondary at 270deg.
function detectPortrait(): boolean {
  try {
    if (screen.orientation?.type.startsWith('portrait')) return true;
  } catch { /* older webview */ }
  try {
    if (window.matchMedia('(orientation: portrait)').matches) return true;
  } catch { /* no matchMedia */ }
  return false;
}

function useIsPortrait(): boolean {
  const [portrait, setPortrait] = useState(detectPortrait);
  useEffect(() => {
    const update = () => setPortrait(detectPortrait());
    let orientation: ScreenOrientation | null = null;
    let mq: MediaQueryList | null = null;
    try {
      orientation = screen.orientation;
      orientation.addEventListener('change', update);
      mq = window.matchMedia('(orientation: portrait)');
      mq.addEventListener('change', update);
    } catch { /* listeners unavailable */ }
    return () => {
      try {
        orientation?.removeEventListener('change', update);
        mq?.removeEventListener('change', update);
      } catch { /* ignore */ }
    };
  }, []);
  return portrait;
}

function AmbientScreen({ client }: { client: BridgethingClient }) {
  useCompanionCfg();
  const [now, setNow] = useState(() => new Date());
  const [tz, setTz] = useState<string | undefined>();
  const [weather, setWeather] = useState<WeatherNow | null>(null);
  const [weatherSettled, setWeatherSettled] = useState(false);
  const [weatherEpoch, setWeatherEpoch] = useState(0);
  const [track, setTrack] = useState<{ title: string; artist: string } | null>(null);
  const [shift, setShift] = useState(BURNIN_STEPS[0]);
  const portrait = useIsPortrait();
  const weatherIntervalMs = useWeatherRefreshMs();

  useEffect(() => {
    let i = 0;
    const t = setInterval(() => {
      i = (i + 1) % BURNIN_STEPS.length;
      setShift(BURNIN_STEPS[i]);
    }, BURNIN_SHIFT_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let live = true;
    client.time
      .get()
      .then(res => {
        if (live && res.ok) setTz(resolveTimeZone(res.response.time));
      })
      .catch(() => {});
    const offTime = client.time.onSnapshot(snap => {
      if (live) setTz(resolveTimeZone(snap.time));
    });
    let minuteTimer: ReturnType<typeof setInterval> | undefined;
    const align = setTimeout(() => {
      if (live) setNow(new Date());
      minuteTimer = setInterval(() => {
        if (live) setNow(new Date());
      }, 60_000);
    }, 60_000 - (Date.now() % 60_000));
    const refreshTrack = () => {
      client.player
        .stateGet()
        .then(res => {
          if (live && res.ok) setTrack(playingTrack(res.response.state));
        })
        .catch(() => {});
    };
    refreshTrack();
    const offDelta = client.player.onDelta(refreshTrack);
    return () => {
      live = false;
      clearTimeout(align);
      clearInterval(minuteTimer);
      offTime();
      offDelta();
    };
  }, [client]);

  useEffect(() => {
    let live = true;
    loadWeather(client).then(w => {
      if (!live) return;
      setWeather(w);
      setWeatherSettled(true);
    });
    const weatherTimer = setInterval(() => {
      loadWeather(client).then(w => {
        if (live && w) setWeather(w);
      });
    }, weatherIntervalMs);
    return () => {
      live = false;
      clearInterval(weatherTimer);
    };
  }, [client, weatherEpoch, weatherIntervalMs]);

  useEffect(() => {
    const effLoc = () => (lsGet(LS_LOC) || companionCfg.weather_location || '').trim();
    const seen = { loc: effLoc(), units: readUnits() };
    const check = () => {
      const loc = effLoc();
      const units = readUnits();
      if (loc !== seen.loc || units !== seen.units) {
        seen.loc = loc;
        seen.units = units;
        setWeatherEpoch(e => e + 1);
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== LS_LOC && e.key !== LS_UNITS) return;
      check();
    };
    window.addEventListener('storage', onStorage);
    companionCfgSubs.add(check);
    return () => {
      window.removeEventListener('storage', onStorage);
      companionCfgSubs.delete(check);
    };
  }, []);

  useEffect(() => {
    let saved: BrightnessState | null = null;
    let cancelled = false;
    const lastCompanionLevel = { current: readDimLevel() };
    (async () => {
      try {
        const res = await client.hardware.stateGet();
        if (!res.ok || cancelled) return;
        saved = res.response.state.brightness;
        await client.hardware.displaySetMode({ mode: 'manual' });
        if (cancelled) return;
        await client.hardware.displaySetLevel({ level: readDimLevel() });
      } catch {
      }
    })();
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== LS_DIM_LEVEL) return;
      const level = readDimLevel();
      lastCompanionLevel.current = level;
      client.hardware.displaySetLevel({ level }).catch(() => {});
    };
    window.addEventListener('storage', onStorage);
    const onCompanion = () => {
      const level = readDimLevel();
      if (level !== lastCompanionLevel.current) {
        lastCompanionLevel.current = level;
        client.hardware.displaySetLevel({ level }).catch(() => {});
      }
    };
    companionCfgSubs.add(onCompanion);
    return () => {
      cancelled = true;
      window.removeEventListener('storage', onStorage);
      companionCfgSubs.delete(onCompanion);
      const prev = saved;
      if (prev) {
        (async () => {
          try {
            await client.hardware.displaySetLevel({ level: prev.level });
            await client.hardware.displaySetMode({ mode: prev.mode });
          } catch {
          }
        })();
      }
    };
  }, [client]);

  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  }).format(now);
  const weekdayOf = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz })
      .format(new Date(`${iso}T12:00:00`))
      .toUpperCase();
  const meta: string[] = [];
  if (weather?.humidity != null) meta.push(`Humidity ${weather.humidity}%`);
  if (weather?.wind != null) meta.push(`Wind ${weather.wind} ${weather.units === 'metric' ? 'km/h' : 'mph'}`);

  if (!weatherSettled) {
    return <div data-testid="ambient-dashboard" className="pointer-events-none absolute inset-0 bg-black" />;
  }

  return (
    <div data-testid="ambient-dashboard" className="pointer-events-none absolute inset-0 bg-black">
      <div
        className={
          portrait ? 'flex h-full flex-col px-8 pt-12 pb-28' : 'flex h-full flex-col justify-between px-10 pt-20 pb-8'
        }
        style={{ transform: `translate(${shift.x}px, ${shift.y}px)`, transition: 'transform 2.5s ease-in-out' }}
      >
        <div className={portrait ? 'flex flex-1 flex-col items-center justify-center gap-5 text-center' : 'flex items-center gap-8'}>
          <div className="shrink-0">
            <WeatherGlyph code={weather?.code} size={portrait ? 96 : 104} night={weather?.isDay === false} />
          </div>
          <div className={portrait ? 'w-full min-w-0' : 'min-w-0'}>
            {weather ? (
              <div>
                <div className={
                    portrait
                      ? 'text-[64px] leading-none font-semibold tabular-nums text-white'
                      : 'text-[72px] leading-none font-semibold tabular-nums text-white'
                  }>
                  {weather.temp}°{weather.units === 'metric' ? 'C' : 'F'}
                </div>
                {weather.label ? (
                  <div className={
                      portrait
                        ? 'mt-1 font-mono text-[20px] lowercase text-white/70'
                        : 'mt-1 font-mono text-[22px] lowercase text-white/70'
                    }>{weather.label}</div>
                ) : null}
              </div>
            ) : null}
            <div className={portrait ? 'mt-2 flex flex-col items-center gap-1.5 font-mono text-[13px] font-medium tracking-[0.18em] text-white/50 uppercase' : 'mt-2 flex flex-col gap-1.5 font-mono text-[13px] font-medium tracking-[0.18em] text-white/50 uppercase'}>
              <div>{date.toUpperCase()}</div>
              {meta.length > 0 ? <div>{meta.join(' / ')}</div> : null}
              {track ? (
                <div className="truncate">
                  ♪ {truncateNowPlaying(`${track.title}${track.artist ? ` — ${track.artist}` : ''}`)}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        {weather && weather.days.length > 0 ? (
          <div>
            <div className="h-px bg-white/10" />
            <div className={portrait ? 'grid grid-cols-5 gap-2 pt-4' : 'grid grid-cols-5 gap-3 pt-4'}>
              {weather.days.map(d => (
                <div
                  key={d.date}
                  className={
                    portrait
                      ? 'forecast-box flex flex-col items-center gap-2 px-1 py-2'
                      : 'forecast-box flex flex-col items-center gap-2 px-2 py-2'
                  }
                >
                  <div className="font-mono text-[12px] font-medium tracking-[0.14em] text-white/40">
                    {weekdayOf(d.date)}
                  </div>
                  <div>
                    <WeatherGlyph code={d.code} size={portrait ? 28 : 30} />
                  </div>
                  <div className={portrait ? 'font-mono text-[13px] tabular-nums' : 'font-mono text-[14px] tabular-nums'}>
                    <span className="text-white">{d.high}</span>
                    <span className="text-white/40"> / </span>
                    <span className="text-white/50">{d.low}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Apps can hold the ambient screen off while the user is watching something
// that needs no touch input (e.g. a Now Playing screen). The overlay bundle
// is injected into the app's own document, so the app signals through a
// sticky window flag plus a DOM event: the flag covers boot ordering (the
// overlay may mount after the app already raised the signal), the event
// covers changes afterwards.
const AMBIENT_INHIBIT_EVENT = 'bridgething:ambient-inhibit';
const AMBIENT_INHIBIT_FLAG = '__bridgethingAmbientInhibit';

function readAmbientInhibit(): boolean {
  try {
    return (window as unknown as Record<string, unknown>)[AMBIENT_INHIBIT_FLAG] === true;
  } catch {
    return false;
  }
}

function useAmbientInhibit(): boolean {
  const [inhibited, setInhibited] = useState(() => readAmbientInhibit());
  useEffect(() => {
    const onInhibit = (e: Event) => {
      const detail = (e as CustomEvent<{ inhibit?: unknown }>).detail;
      setInhibited(detail?.inhibit === true);
    };
    window.addEventListener(AMBIENT_INHIBIT_EVENT, onInhibit);
    // Re-read the sticky flag in case the app raised it before we mounted.
    setInhibited(readAmbientInhibit());
    return () => window.removeEventListener(AMBIENT_INHIBIT_EVENT, onInhibit);
  }, []);
  return inhibited;
}

function Ambient({ client }: { client: BridgethingClient }) {
  const idleMs = useAmbientIdleMs();
  const idle = useIdle(idleMs);
  const enabled = useAmbientEnabled();
  const inhibited = useAmbientInhibit();
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const offs = [
      client.phone.onCallStarted(() => setBlocked(true)),
      client.phone.onCallEnded(() => setBlocked(false)),
      client.bluetooth.onPin(() => setBlocked(true)),
      client.bluetooth.onPairingResult(() => setBlocked(false)),
    ];
    return () => offs.forEach(off => off());
  }, [client]);

  if (!enabled || !idle || blocked || inhibited) return null;
  return <AmbientScreen client={client} />;
}

type Dismissible = (hide: () => void) => () => void;

function Overlay({ cfg, client }: { cfg: OverlayConfig; client: BridgethingClient }) {
  const [stack] = useState<Array<() => void>>([]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || stack.length === 0) return;
      event.stopPropagation();
      event.preventDefault();
      stack.pop()?.();
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, [stack]);

  const dismissible: Dismissible = hide => {
    stack.push(hide);
    return () => {
      const at = stack.indexOf(hide);
      if (at >= 0) stack.splice(at, 1);
    };
  };

  return (
    <>
      <style>{css}</style>
      <div className="absolute inset-0 font-sans">
        <Ambient client={client} />
        {cfg.surfaces.connection && <ConnectionBanner client={client} />}
        {cfg.surfaces.call && <CallCard client={client} onDismissible={dismissible} />}
        {cfg.surfaces.notifications && <Toasts client={client} />}
        {cfg.surfaces.volume && <VolumeBar client={client} />}
        {cfg.surfaces.pairing && <PairingModal client={client} onDismissible={dismissible} />}
        {cfg.surfaces.voice && <VoicePill client={client} />}
      </div>
    </>
  );
}

function boot() {
  const cfg = window.__bridgethingOverlay;
  if (!cfg || !location.origin.startsWith(cfg.origin)) return;
  if (window.__bridgethingOverlayMounted) return;
  window.__bridgethingOverlayMounted = true;

  const mount = () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'closed' });
    document.body.appendChild(host);
    const client = new BridgethingClient({ url: cfg.url ?? `ws://${location.host}/` });
    if (cfg.url) syncCompanionCfg(client);
    render(<Overlay cfg={cfg} client={client} />, shadow);
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

boot();
