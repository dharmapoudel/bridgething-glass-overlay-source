import { copyFile, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(fileURLToPath(import.meta.url));
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const modDir = join(root, 'node_modules', '@bridgething', 'source', 'dist');
const pkg = require(join(modDir, '..', 'package.json'));
const lib = await import(join(modDir, 'lib.js'));
const catalog = await import(join(modDir, 'catalog.js'));
const { LEDGER_FILE, CATALOG_FILE } = await import(join(modDir, 'paths.js'));

const EPOCH = new Date('2020-01-01T00:00:00Z');
async function flattenTimestamps(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await flattenTimestamps(path);
    await utimes(path, EPOCH, EPOCH);
  }
}

async function bundleOverlay(app, output) {
  lib.run('bun', ['run', 'typecheck'], app.dir);
  lib.run('bun', ['run', 'build'], app.dir);
  const dist = join(app.dir, 'dist');
  const entries = (await readdir(dist).catch(() => [])).filter(e => !e.startsWith('.'));
  if (!entries.length) throw new Error(`apps/${app.slug} built nothing into dist/`);
  const built = await lib.readJson(join(dist, 'manifest.json')).catch(() => {
    throw new Error(`apps/${app.slug}/dist has no manifest.json`);
  });
  if (built.version !== app.manifest.version)
    throw new Error(`apps/${app.slug} built version ${built.version} but public/manifest.json says ${app.manifest.version}`);
  if (!entries.includes('overlay.js'))
    throw new Error(`apps/${app.slug}/dist has no overlay.js`);
  let iconPath = null, iconExt = null;
  if (built.icon) {
    const candidate = join(dist, built.icon);
    if (!(await stat(candidate).catch(() => null))?.isFile())
      throw new Error(`apps/${app.slug} declares icon "${built.icon}" which is not in the bundle`);
    iconPath = candidate;
    iconExt = built.icon.split('.').pop().toLowerCase();
  }
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  await flattenTimestamps(dist);
  lib.run('zip', ['-q', '-X', '-r', '-D', output, ...entries.sort()], dist);
  return { zip: output, size: (await stat(output)).size, sha256: await lib.sha256(output), iconPath, iconExt };
}

async function copyScreenshots(app, site) {
  const dir = join(app.dir, 'screenshots');
  if (!existsSync(dir)) return;
  const shots = (await readdir(dir)).filter(f => !f.startsWith('.')).sort();
  if (!shots.length) return;
  const out = join(site, 'screenshots', app.manifest.id);
  await mkdir(out, { recursive: true });
  for (const shot of shots) await copyFile(join(dir, shot), join(out, shot));
}

const source = await lib.readSource();
const apps = await lib.listApps();
const base = lib.publicBase(source);
const site = join(root, 'site');
await mkdir(site, { recursive: true });
const ledgerPath = join(site, LEDGER_FILE);
const ledger = existsSync(ledgerPath) ? await lib.readJson(ledgerPath) : {};

for (const app of apps) {
  const published = (ledger[app.manifest.id] ??= {});
  if (published[app.manifest.version]) {
    console.log(`${app.slug} ${app.manifest.version} already published, skipping`);
    continue;
  }
  const file = `r/${app.manifest.id}/${app.manifest.version}.zip`;
  await mkdir(join(site, 'r', app.manifest.id), { recursive: true });
  const built = await bundleOverlay(app, join(site, `${app.slug}.staging.zip`));
  await rename(built.zip, join(site, file));
  console.log(`bundle ok: ${(built.size / 1024).toFixed(0)} KiB, sha256 ${built.sha256.slice(0, 12)}`);
  if (built.iconPath && built.iconExt) {
    await mkdir(join(site, 'icons'), { recursive: true });
    await copyFile(built.iconPath, join(site, 'icons', `${app.manifest.id}.${built.iconExt}`));
  }
  await copyScreenshots(app, site);
  published[app.manifest.version] = {
    released_at: new Date().toISOString(),
    sha256: built.sha256,
    size: built.size,
    file,
  };
}

const result = await catalog.generate(source, apps, ledger, base, site);
catalog.validate(result);
await lib.writeJson(join(site, CATALOG_FILE), result);
await lib.writeJson(join(site, LEDGER_FILE), ledger);
await lib.writeText(join(site, '.nojekyll'), '');
console.log(`\nstaged ${result.apps.length} app(s) into site/ against ${base}`);
console.log(`@bridgething/source ${pkg.version}; overlay-aware bundling only, official generate+validate`);
