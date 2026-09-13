# Glassy Overlay

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
