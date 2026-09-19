# Glassy Overlay

## 0.3.21

- Reverts 0.3.20: hiding the app from the device app list did not work
  as intended on-device, so the on-device settings page is back at
  `index.html` and the app appears in the app list again, as in 0.3.19.

## 0.3.20

- The app no longer appears in the device's app list: the on-device
  settings page moved from `index.html` to `settings.html` and is now
  declared via the manifest's `settings` field (the supported upstream
  mechanism), so the daemon no longer treats the bundle as a launchable
  app. The settings page itself is unchanged and still reachable from
  the app's settings entry.

## 0.3.19

- Companion-app settings now sync to the overlay in realtime over the
  daemon (requires Bridgething 0.13.1+): ambient enable, dim level,
  idle timeout, weather units, and location all apply the moment you
  change them in the companion app, including while the screensaver is
  showing. Settings page hints refresh live the same way. Device-side
  overrides still win over the companion defaults.
- Settings page changes (idle timeout, dim, location) broadcast to
  the running overlay on the same tab via storage events.
- Note: on Bridgething 0.12.x the overlay keeps its old behavior
  (device-local settings only) — realtime sync activates once the
  device runs 0.13.1 or newer.

## 0.3.18

- The screensaver no longer flashes the partially loaded screen: it stays
  black (already dimmed) until the first weather load settles, then shows
  the full dashboard.
- Screensaver intensity is now a slider (was a number box) on the
  settings page. The companion app has no slider field type in the
  manifest schema, so it keeps the number box there.
- Idle timeout is now 5 tiles (15s, 30s, 1m, 2m, 5m) on the settings page
  with companion-default mirroring. The companion setting changed from a
  number to an enum, so it shows the same 5 options as segments.
- Settings page: left margin removed, right margin cut to 10px.

## 0.3.17

- New "Screensaver intensity" setting on both sides: a number field in
  the manifest config (companion app) and a card on the settings page.
  Controls brightness while the screensaver is showing, 5-100%,
  default 15%. Applies live without restarting the screensaver.

## 0.3.16

- Settings page redesigned in the companion app's design language:
  black, monospace, uppercase letter-spaced labels, thin-bordered
  cards, blue accent, one reset button per card. Screensaver is now a
  switch, idle timeout a number input, units a segmented control,
  location saves on commit.
- Fixed the top of the settings page being cut off on the device: the
  old flex-centering pushed content above the viewport once it grew
  taller than the screen; the page now scrolls normally.

## 0.3.15

- Battery: the ambient screen showed the date only but re-rendered every
  second — the clock now ticks once a minute. The idle-timeout watcher
  polled every 5s; it now listens for storage events from the settings
  page with a 60s fallback. The phone's location fix is cached 6h so the
  30-minute weather refresh no longer wakes the phone radio each time.
- New `ambient_enabled` boolean in the manifest config: the companion
  app gets an "Ambient screensaver" toggle, mirrored by the settings
  page (explicit device choice wins). The settings page also has its
  own Screensaver On/Off toggle; the overlay picks the change up
  instantly and never shows the ambient screen while off.
- Cleanup: shared localStorage get/set helpers replace the scattered
  try/catch blocks in the overlay.

## 0.3.14

- Reverted the 0.3.12/0.3.13 reference restyle; ambient is back to the
  0.3.11 look with forecast tiles slightly smaller (30px glyphs, 14px
  temps, 12px day labels, py-2).

## 0.3.13

- Forecast tiles shrunk to reference proportions: py-3, 40px glyphs,
  20px temps, 13px day labels.

## 0.3.12

- Ambient hero restyled to the reference: larger glyph (150px) and
  temperature (120px), dimmer gray condition, meta line in dim gray with
  the wind unit dropped (`HUMIDITY 55% / WIND 4`). Forecast tiles are
  taller with larger glyphs (48px) and temperatures (22px).

## 0.3.11

- Settings page mirrors the effective weather location/units into the
  localStorage keys the overlay reads, since the overlay cannot read
  companion config on daemon 0.12.10. Fixes companion-set metric rendering
  as °F when nothing was explicitly saved on the device. Explicit device
  choices still win; mirrored companion values refresh when the companion
  default changes.

## 0.3.10

- Weather glyphs keep their color but muted; meta lines and forecast day
  names dimmed to match the reference font colors.

## 0.3.9

- Ambient forecast tile borders and divider muted to match the reference.

## 0.3.8

- Ambient top-block spacing tuned to the midpoint between the reference
  and the original layout.

## 0.3.7

- Clear sky at night shows a moon glyph instead of the sun (uses
  Open-Meteo `is_day`); ambient top block pushed down to match the
  reference layout.

## 0.3.6

- Ambient weather matches the reference design: full-color emoji glyphs
  (line icons retired), monospace meta lines (condition, humidity/wind,
  date, now playing), forecast tiles with bright high / muted low temps.

## 0.3.5

- Companion app settings: "Weather location" and "Weather units" fields in
  the per-app settings (manifest `config`). The on-device settings page
  reads them as defaults — a value saved on the device overrides the
  companion default, clearing it falls back to the companion value.
- Idle input guard: the ambient dashboard no longer activates while touch,
  knob, or key input is actively happening. The idle timer now also resets
  on move/up/release events, so a long press-drag or scroll gesture keeps
  the screen awake until the interaction ends.

## 0.3.4

- Ambient dashboard redesigned: full-screen weather layout (current
  conditions, humidity/wind, date, now-playing line, 5-day forecast) in
  place of the clock. The content shifts a few pixels every minute to
  prevent screen burn-in during long idle periods.
- Settings page gains a weather location field (city name or "lat,lon";
  blank uses the phone's location via the companion app, cached after the
  first geocode lookup) and an Imperial/Metric units toggle.

## 0.3.3

- Launcher settings page: tapping Glassy Overlay in the launcher opens an
  ambient-timeout settings page (15s–60min presets, tap to save). The choice
  is stored in the kiosk's shared localStorage, which the overlay reads on
  every page load and re-checks every few seconds — no daemon changes
  needed, no restart required. The companion app's per-app setting still
  waits on the upstream daemon fix.

## 0.3.2

- Default ambient idle timeout lowered from 5 minutes to 30 seconds
  (still configurable from 15 seconds to 60 minutes in the app settings).

## 0.3.1

- New "Ambient dashboard idle timeout (seconds)" setting in the companion
  app's per-app settings (15s–60min, default 30s since 0.3.2). The overlay reads it
  from the injected daemon config; takes effect once the daemon passes
  overlay settings through (pending upstream daemon support).

## 0.3.0

- Ambient dashboard: after five minutes without input, a full-screen
  clock/date, weather (Open-Meteo via the phone gateway, no API key), now
  playing, and unread notification count fade in over every app, and the
  backlight dims to 15%. Any knob, button, or touch input wakes the screen
  and restores the previous brightness. Suppressed while a call or
  Bluetooth pairing is active.
- No new manifest permissions: the overlay needs none for the ambient
  screen (network goes through the phone gateway; location is tried
  opportunistically and falls back to a home constant).

## 0.2.0

- Overlay-only bundle: no `index.html`, so the app no longer appears in the
  Car Thing launcher (requires daemon 0.12.10+, which auto-detects
  overlay-only bundles). The overlay stays installed and manageable from
  the companion app.
- Voice pill now floats above the volume bar instead of covering it.
- Notification toasts tolerate missing `flags`/`app` fields.

## 0.1.0

- First release: glass-style notification toasts, call card with
  answer/decline/end, Bluetooth pairing PIN modal, disconnected-phone
  banner, volume bar, and voice status pill.
- Takes over the system overlay slot; a placeholder launcher page pointed
  at the companion app's overlay settings.
