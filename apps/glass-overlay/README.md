# Glassy Overlay

A replacement system overlay for the Spotify Car Thing, built for
[bridgething](https://bridgething.com). It takes over the overlay slot and
draws a glass-style UI over every app: notification toasts, the call card,
the Bluetooth pairing PIN, the disconnected-phone banner, the volume bar,
and the voice status pill.

This is an overlay-only bundle: it ships no launcher page and never appears
in the Car Thing launcher. It stays installed and manageable from the
companion app. Requires daemon 0.12.10 or newer.

## Surfaces

- **Notifications** — glass toasts slide in from the top right, up to three
  at once, auto-dismissing after five seconds. Silent notifications are
  skipped.
- **Call card** — centered glass card with caller name, call status, and
  answer/decline/end buttons that drive the phone through the daemon.
- **Pairing PIN** — large mono PIN with the device name, shown while
  Bluetooth pairing is in progress. Esc dismisses it.
- **Connection banner** — a quiet pill up top when the paired phone drops
  its useful link, after a short grace period.
- **Volume bar** — bottom-centered glass bar with percentage and a muted
  state, fading out shortly after the last change.
- **Voice pill** — listening / thinking / done / sorry states with a
  color-coded dot, floating above the volume bar.

Claim the overlay slot in the companion app under Settings → Home screen
and overlay → System overlay, then pick **Glassy Overlay**.

## Develop

```sh
bun install
bun run typecheck  # tsc --noEmit
bun run build      # writes dist/overlay.js
bun run share      # zips dist/ into Glassy-Overlay-<version>.zip
bun run push       # build and install onto the connected Car Thing
```

The overlay entry is `overlay/main.tsx`, built as a single IIFE into
`dist/overlay.js` (must stay under the daemon's 512 KiB overlay cap).
It mounts into a closed shadow root on the daemon's overlay host page and
talks to the daemon through `@bridgething/client`.

One shadow-DOM gotcha is documented in `overlay/style.css`: Chromium does
not apply `@property` registrations inside a shadow tree, so Tailwind v4
utilities that resolve through `var()` of a registered property silently
break here. Prefer concrete CSS or flex-based centering.

## License

MIT.
