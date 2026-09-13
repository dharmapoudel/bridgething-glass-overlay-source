import type {
  BluetoothPin,
  Notification,
  PeerSnapshotMap,
  PhoneCall,
  VolumeChanged,
} from '@bridgething/client';
import { BridgethingClient } from '@bridgething/client';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import css from './style.css?inline';

type OverlaySurfaces = {
  notifications: boolean;
  call: boolean;
  pairing: boolean;
  connection: boolean;
  volume: boolean;
  voice: boolean;
};

type OverlayConfig = { origin: string; surfaces: OverlaySurfaces };

declare global {
  interface Window {
    __bridgethingOverlay?: OverlayConfig;
    __bridgethingOverlayMounted?: boolean;
  }
}

const TOAST_TTL_MS = 5_000;
const MAX_TOASTS = 3;
const VOLUME_TTL_MS = 1_500;
const CONNECTION_SHOW_DELAY_MS = 3_000;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

/* ---------------- notifications ---------------- */

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

/* ---------------- call ---------------- */

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

/* ---------------- pairing ---------------- */

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

/* ---------------- connection ---------------- */

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

/* ---------------- volume ---------------- */

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

/* ---------------- voice ---------------- */

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

/* ---------------- root ---------------- */

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
    render(<Overlay cfg={cfg} client={new BridgethingClient({ url: `ws://${location.host}/` })} />, shadow);
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

boot();
