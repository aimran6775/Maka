// When the macOS shell spawned this sidecar (MAKA_SHELL=tauri) and then died without
// stopping it — SIGKILL, a crash, the dev watcher's rebuild — the process is reparented
// and the crew would keep running headless, invisible to the owner and squatting on the
// port the next shell needs (seen on the Mac: tauri dev's rebuild left the old sidecar
// holding 8791 and the new app crash-looped on EADDRINUSE). The shell owns the sidecar's
// lifetime (the release smoke check's SIGTERM rule), so an orphaned sidecar exits.
// Outside the app (no MAKA_SHELL) nothing watches: `npm start` owns itself.

export function startOrphanWatch({
  env = process.env,
  getppid = () => process.ppid,
  exit = (code) => process.exit(code),
  log = console,
  intervalMs = 2000,
} = {}) {
  if (env.MAKA_SHELL !== 'tauri') return null;
  const shellPid = getppid();
  const timer = setInterval(() => {
    const now = getppid();
    if (now !== shellPid) {
      log.error(`maka shell (pid ${shellPid}) is gone (reparented to ${now}); the sidecar exits with it`);
      clearInterval(timer);
      exit(0);
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
