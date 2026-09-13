# bridgething-glass-overlay-source

A [bridgething](https://bridgething.com) `catalog.v1` source publishing
[Glassy Overlay](https://github.com/dharmapoudel/bridgething-glass-overlay),
served at <https://dharmapoudel.github.io/bridgething-glass-overlay-source/catalog.v1.json>.

## Layout

- `apps/glass-overlay/` — the overlay app (see its README for development).
- `scripts/stage-overlay.mjs` — stages `site/` for publishing.

## Publishing

`@bridgething/source@0.12.1` predates overlay-only bundles: its `bundle()`
gate hard-fails on a `dist/` with no `index.html`. Until the pipeline
supports overlay-only apps, this source stages with
`scripts/stage-overlay.mjs` instead of `bun run catalog`. The script reuses
the pipeline's own `generate` + `validate` (so the catalog is byte-identical
in shape to a pipeline-staged one) and only replaces the bundling step:
typecheck, build, reproducible zip (`zip -q -X -r -D` after flattening
timestamps to the same epoch the pipeline uses), icon + screenshot copy,
and ledger update.

```sh
node scripts/stage-overlay.mjs   # stages site/
```

Then push `site/` to the `gh-pages` branch (GitHub Pages serves it).
`site/` is generated and never committed to `main`.
