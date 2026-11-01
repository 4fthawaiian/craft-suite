#!/usr/bin/env node
// update.js — fetch the latest web builds for the configured Craft apps from
// GitHub releases, extract them, apply local patches, inject the storage shim.
// Idempotent: skips apps already at the latest release unless --force.
//
// Usage: node update.js [--force] [--apps gridcraft,wordcraft,...]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = __dirname;
const VERSIONS_FILE = path.join(ROOT, 'versions.json');
const ALL_APPS = ['gridcraft', 'wordcraft', 'deckcraft', 'pdfcraft', 'photocraft',
  'figcraft', 'vectorcraft', 'lightcraft', 'effectcraft', 'designcraft',
  'soundcraft', 'cadcraft'];

const args = process.argv.slice(2);
const force = args.includes('--force');
const appsArg = args.find(a => a.startsWith('--apps='));
const APPS = appsArg ? appsArg.slice(7).split(',') : ALL_APPS.slice(0, 6);

const SHIM_TAG = '  <script src="/suite-shim.js"></script>\n</head>';

let versions = {};
try { versions = JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8')); } catch {}

async function gh(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'craft-suite-updater' } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function injectShim(dir) {
  const idx = path.join(dir, 'index.html');
  let html = fs.readFileSync(idx, 'utf8');
  if (html.includes('suite-shim.js')) return;
  if (!html.includes('</head>')) { console.log('  ! no </head> in index.html, shim not injected'); return; }
  html = html.replace('</head>', SHIM_TAG);
  fs.writeFileSync(idx, html);
}

function applyPatches(app, dir) {
  // photocraft: app/photocraft-web.js imports ./snippets/ relative to app/
  const appGlue = path.join(dir, 'app', 'photocraft-web.js');
  const appSnippets = path.join(dir, 'app', 'snippets');
  const rootSnippets = path.join(dir, 'snippets');
  if (app === 'photocraft' && fs.existsSync(appGlue) &&
      fs.existsSync(rootSnippets) && !fs.existsSync(appSnippets)) {
    fs.cpSync(rootSnippets, appSnippets, { recursive: true });
    console.log('  patched: copied snippets/ into app/');
  }
}

async function updateApp(app) {
  const rel = await gh(`https://api.github.com/repos/storytold/${app}/releases/latest`);
  const tag = rel.tag_name;
  const asset = (rel.assets || []).find(a => /-web-.*\.zip$/.test(a.name));
  if (!asset) { console.log(`${app}: no web build in ${tag}, skipped`); return; }
  if (!force && versions[app] === tag) { console.log(`${app}: already ${tag}`); return; }

  console.log(`${app}: ${versions[app] || 'none'} -> ${tag} (${(asset.size / 1048576).toFixed(1)} MB)`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `craft-${app}-`));
  try {
    const zip = path.join(tmp, 'web.zip');
    fs.writeFileSync(zip, Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer()));
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out);
    execFileSync('unzip', ['-o', '-q', zip, '-d', out]);

    // flatten the single versioned top dir the zips contain
    let src = out;
    const entries = fs.readdirSync(out);
    if (entries.length === 1 && fs.statSync(path.join(out, entries[0])).isDirectory())
      src = path.join(out, entries[0]);

    const dest = path.join(ROOT, app);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(src, dest);

    applyPatches(app, dest);
    injectShim(dest);
    versions[app] = tag;
    console.log(`  ok`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  for (const app of APPS) {
    try { await updateApp(app); }
    catch (e) { console.log(`${app}: FAILED - ${e.message}`); }
  }
  fs.writeFileSync(VERSIONS_FILE, JSON.stringify(versions, null, 2) + '\n');
  console.log('done');
})();
