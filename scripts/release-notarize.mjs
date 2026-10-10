#!/usr/bin/env node
// `node scripts/release-notarize.mjs --dmg dist/release/Maka-<v>-aarch64.dmg [--app <path>] [--dry-run]`:
// submits the .dmg to Apple's notary service with notarytool, waits for the verdict,
// staples the ticket, and verifies the signature and Gatekeeper's assessment of both the
// .app inside the bundle directory and the .dmg. Tauri's bundler already notarized and
// stapled the .app; the .dmg is a second file Gatekeeper checks, so it gets its own
// ticket. Credentials: a notarytool keychain profile (NOTARY_PROFILE, default
// `maka-notary`, made once with `xcrun notarytool store-credentials`) when it exists,
// else APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID from the environment. Idempotent: a
// file that is already notarized is accepted again at once.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, createRunner, exists, REPO_ROOT } from './release-lib.mjs';

export async function notarize({ dmg, app = null, dryRun = false, env = process.env, log = console, runner = createRunner({ dryRun, log, env }), profile = env.NOTARY_PROFILE || 'maka-notary' } = {}) {
  if (!dmg) throw new Error('notarize needs the .dmg path');
  if (!dryRun && !(await exists(dmg))) throw new Error(`${dmg} does not exist`);
  const haveProfile = !dryRun && runner.run('xcrun', ['notarytool', 'history', '--keychain-profile', profile], { allowFail: true, capture: true, note: `is the notarytool keychain profile "${profile}" stored?` }).status === 0;
  const useArgs = !haveProfile;
  const missing = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'].filter((k) => !env[k]);
  if (useArgs && missing.length && !dryRun) throw new Error(`notarytool needs a keychain profile "${profile}" (xcrun notarytool store-credentials ${profile} --apple-id … --team-id … --password …) or ${missing.join(', ')} in the environment`);
  const auth = useArgs ? ['--apple-id', env.APPLE_ID || '<APPLE_ID>', '--team-id', env.APPLE_TEAM_ID || '<APPLE_TEAM_ID>', '--password', env.APPLE_PASSWORD ? '<APPLE_PASSWORD>' : '<APPLE_PASSWORD>'] : ['--keychain-profile', profile];
  // The password never goes on a command line: notarytool reads it from the environment
  // when told to. (`--password` is shown as a placeholder in the plan.)
  const authReal = useArgs ? ['--apple-id', env.APPLE_ID || '', '--team-id', env.APPLE_TEAM_ID || '', '--password', '@env:APPLE_PASSWORD'] : ['--keychain-profile', profile];
  runner.run('xcrun', ['notarytool', 'submit', dmg, ...(dryRun ? auth : authReal), '--wait'], { note: 'submit the .dmg to the notary service and wait for the verdict (minutes)', secretEnv: useArgs ? ['APPLE_PASSWORD'] : [] });
  runner.run('xcrun', ['stapler', 'staple', dmg], { note: 'attach the ticket so the .dmg opens offline' });
  runner.run('xcrun', ['stapler', 'validate', dmg]);
  runner.run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', dmg], { note: 'Gatekeeper accepts the .dmg' });
  if (app) {
    runner.run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { note: 'every binary in the bundle is signed (shell, Node, frameworks)' });
    runner.run('spctl', ['--assess', '--type', 'execute', '-vv', app], { note: 'Gatekeeper accepts the .app (notarized by the bundler)' });
    runner.run('xcrun', ['stapler', 'validate', app]);
  }
  return { dmg, app, profile: useArgs ? null : profile, dryRun };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { flags } = parseArgs(process.argv.slice(2));
  notarize({ dmg: flags.dmg ? path.resolve(flags.dmg) : null, app: flags.app ? path.resolve(flags.app) : null, dryRun: Boolean(flags['dry-run']) })
    .then((r) => console.log(`notarized and stapled ${r.dmg}${r.dryRun ? ' (dry run)' : ''}`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
