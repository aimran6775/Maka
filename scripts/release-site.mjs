#!/usr/bin/env node
// `node scripts/release-site.mjs [--dry-run] [--notes "…"]`: assembles the download site
// under dist/site/: website/ as it is, plus releases/latest.json (the Tauri updater's
// static manifest with the signature from the .sig file), releases/download.json (what
// the page shows: the .dmg's URL, size and SHA-256), releases/SHA256SUMS, and the
// artifacts themselves. In a dry run the manifests say so (`dryRun: true`, placeholder
// hashes and signature) and nothing is copied.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readVersion, sha256File, updaterManifest, downloadManifest, artifactNames, exists, DEFAULT_TRIPLE, TRIPLES, SITE_ORIGIN, RELEASES_PATH, REPO_ROOT } from './release-lib.mjs';

export async function site({ root = REPO_ROOT, out = path.join(root, 'dist'), triple = DEFAULT_TRIPLE, version = null, notes = '', pubDate = Date.now(), artifacts = null, dryRun = false, log = console } = {}) {
  const v = version || (await readVersion(root));
  const names = artifactNames({ version: v, triple });
  const releaseDir = path.join(out, 'release');
  const files = artifacts || { dmg: path.join(releaseDir, names.dmg), updater: path.join(releaseDir, names.updater), signature: path.join(releaseDir, names.signature) };
  const siteDir = path.join(out, 'site');
  const relDir = path.join(siteDir, RELEASES_PATH);
  await fsp.rm(siteDir, { recursive: true, force: true });
  await fsp.mkdir(relDir, { recursive: true });
  // website/ as committed (the page is version-free).
  for (const name of await fsp.readdir(path.join(root, 'website'))) {
    if (name === 'releases' || name.startsWith('.')) continue;
    await fsp.copyFile(path.join(root, 'website', name), path.join(siteDir, name));
  }
  const urls = { dmg: `${SITE_ORIGIN}/${RELEASES_PATH}/${names.dmg}`, updater: `${SITE_ORIGIN}/${RELEASES_PATH}/${names.updater}` };
  let dmgSha = 'dry-run';
  let dmgBytes = 0;
  let signature = 'DRY-RUN-SIGNATURE';
  if (!dryRun) {
    for (const [k, f] of Object.entries(files)) if (!(await exists(f))) throw new Error(`missing ${k}: ${f}`);
    dmgSha = await sha256File(files.dmg);
    dmgBytes = (await fsp.stat(files.dmg)).size;
    signature = (await fsp.readFile(files.signature, 'utf8')).trim();
    if (!signature) throw new Error(`${files.signature} is empty`);
    for (const [k, f] of Object.entries(files)) await fsp.copyFile(f, path.join(relDir, names[k]));
    const sums = [];
    for (const k of ['dmg', 'updater']) sums.push(`${await sha256File(files[k])}  ${names[k]}`);
    await fsp.writeFile(path.join(relDir, 'SHA256SUMS'), sums.join('\n') + '\n');
  }
  const latest = updaterManifest({ version: v, notes, pubDate, platforms: { [TRIPLES[triple].updater]: { url: urls.updater, signature } } });
  if (dryRun) latest.dryRun = true;
  const download = downloadManifest({ version: v, pubDate, notes, triple, dmg: { name: names.dmg, url: urls.dmg, sha256: dmgSha, bytes: dmgBytes }, dryRun });
  await fsp.writeFile(path.join(relDir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
  await fsp.writeFile(path.join(relDir, 'download.json'), JSON.stringify(download, null, 2) + '\n');
  log.info(`${dryRun ? '[dry-run] ' : ''}site assembled at ${siteDir} (latest.json → ${urls.updater}, download.json → ${urls.dmg})`);
  return { siteDir, releasesDir: relDir, latest, download, urls, names };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { flags } = parseArgs(process.argv.slice(2));
  site({ root: flags.root ? path.resolve(flags.root) : REPO_ROOT, out: flags.out ? path.resolve(flags.out) : undefined, triple: flags.triple || DEFAULT_TRIPLE, notes: flags.notes || '', dryRun: Boolean(flags['dry-run']) })
    .then((r) => console.log(`site: ${r.siteDir}`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
