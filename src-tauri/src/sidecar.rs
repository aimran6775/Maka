//! The sidecar launcher: finds the bundled Node and the bundled repository, picks a free
//! port, starts `node sidecar/index.js` with the app's data directory as `MAKA_HOME`, logs
//! its output to `<home>/logs/sidecar.log`, waits until `/api/state` answers, and stops
//! it cleanly (SIGTERM, then SIGKILL) when the shell quits.
//!
//! Nothing in here guesses: a missing Node or repository is a plain error with the paths
//! that were tried, shown on the splash page.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::local_http;

/// Exit code the sidecar may use to ask for an immediate restart (reserved; the sidecar
/// restarts itself in-process for a workspace change, so the shell only sees it on a
/// crash). Kept so the monitor loop can tell the two apart in the log.
pub const EXIT_RESTART: i32 = 75;
pub const LOG_CAP_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Launch {
    pub node: PathBuf,
    pub repo: PathBuf,
    pub home: PathBuf,
    pub port: u16,
    /// Extra environment for the sidecar (the credential broker's socket and token).
    pub env: Vec<(String, String)>,
}

pub struct Sidecar {
    child: Child,
    pub port: u16,
    pub url: String,
    pub log_path: PathBuf,
    pub started_at: Instant,
}

// A bundled or PATH candidate must be executable: the dev loop copies shell-check's
// 0644 placeholder next to the exe, and it must lose to `node` on PATH, not be spawned.
fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return fs::metadata(p).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false);
    }
    #[cfg(not(unix))]
    true
}

/// Where the sidecar's Node binary is. Order: `MAKA_NODE`, `node` next to the shell's
/// executable (how Tauri lays out an `externalBin`), then `node` on `PATH` (development).
pub fn find_node(exe_dir: Option<&Path>, env_node: Option<&str>, path_var: Option<&str>) -> Result<PathBuf, String> {
    let mut tried = Vec::new();
    if let Some(p) = env_node.filter(|s| !s.trim().is_empty()) {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
        tried.push(p);
    }
    if let Some(dir) = exe_dir {
        for name in ["node", "node-aarch64-apple-darwin", "node-x86_64-apple-darwin"] {
            let p = dir.join(name);
            if p.is_file() && is_executable(&p) {
                return Ok(p);
            }
            tried.push(p);
        }
    }
    if let Some(path) = path_var {
        for dir in path.split(':').filter(|d| !d.is_empty()) {
            let p = Path::new(dir).join("node");
            if p.is_file() && is_executable(&p) {
                return Ok(p);
            }
        }
        tried.push(PathBuf::from("node (on PATH)"));
    }
    Err(format!(
        "no Node binary found; tried {}. Set MAKA_NODE or build the app with scripts/release-build.mjs, which bundles Node.",
        tried.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
    ))
}

/// Where `sidecar/index.js`, `shared/` and `frontend/` are. Order: `MAKA_REPO`, the app's
/// resource directory (the bundle copies the three directories and package.json there),
/// then the repository this crate was built from (development only).
pub fn find_repo(resource_dir: Option<&Path>, env_repo: Option<&str>) -> Result<PathBuf, String> {
    let mut tried = Vec::new();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = env_repo.filter(|s| !s.trim().is_empty()) {
        candidates.push(PathBuf::from(p));
    }
    if let Some(r) = resource_dir {
        candidates.push(r.to_path_buf());
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join(".."));
    for c in candidates {
        if c.join("sidecar").join("index.js").is_file() && c.join("package.json").is_file() {
            return Ok(c.canonicalize().unwrap_or(c));
        }
        tried.push(c);
    }
    Err(format!(
        "no sidecar found; tried {}. Set MAKA_REPO to a checkout of the Maka repository.",
        tried.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
    ))
}

pub fn free_port() -> io::Result<u16> {
    let l = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(l.local_addr()?.port())
}

/// Opens the sidecar log for appending; a log past LOG_CAP_BYTES starts over.
pub fn open_log(home: &Path) -> io::Result<(File, PathBuf)> {
    let dir = home.join("logs");
    fs::create_dir_all(&dir)?;
    let path = dir.join("sidecar.log");
    if fs::metadata(&path).map(|m| m.len() > LOG_CAP_BYTES).unwrap_or(false) {
        fs::remove_file(&path)?;
    }
    let f = OpenOptions::new().create(true).append(true).open(&path)?;
    Ok((f, path))
}

pub fn spawn(launch: &Launch) -> Result<Sidecar, String> {
    fs::create_dir_all(&launch.home).map_err(|e| format!("cannot create {}: {e}", launch.home.display()))?;
    let (log, log_path) = open_log(&launch.home).map_err(|e| format!("cannot open the sidecar log: {e}"))?;
    let err_log = log.try_clone().map_err(|e| e.to_string())?;
    let entry = launch.repo.join("sidecar").join("index.js");
    let mut cmd = Command::new(&launch.node);
    cmd.arg(&entry)
        .current_dir(&launch.repo)
        .env("PORT", launch.port.to_string())
        .env("HOST", "127.0.0.1")
        .env("MAKA_HOME", &launch.home)
        .env("MAKA_SHELL", "tauri")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err_log));
    for (k, v) in &launch.env {
        cmd.env(k, v);
    }
    let child = cmd.spawn().map_err(|e| format!("cannot start {} {}: {e}", launch.node.display(), entry.display()))?;
    Ok(Sidecar { child, port: launch.port, url: format!("http://127.0.0.1:{}", launch.port), log_path, started_at: Instant::now() })
}

/// Polls `/api/state` until it answers 200 or the deadline passes. Returns early with the
/// exit status if the process dies first.
pub fn wait_ready(sidecar: &mut Sidecar, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let probe = format!("{}/api/state", sidecar.url);
    loop {
        if let Ok(Some(status)) = sidecar.child.try_wait() {
            return Err(format!("the sidecar exited during startup ({status}); see {}", sidecar.log_path.display()));
        }
        if let Ok(r) = local_http::get(&probe, Duration::from_millis(500)) {
            if r.status == 200 {
                return Ok(());
            }
        }
        if Instant::now() > deadline {
            return Err(format!("the sidecar did not answer on {} within {}s; see {}", sidecar.url, timeout.as_secs(), sidecar.log_path.display()));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

impl Sidecar {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Non-blocking: Some(code) once the process has exited.
    pub fn exited(&mut self) -> Option<Option<i32>> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.code()),
            _ => None,
        }
    }

    /// Blocks until the process exits; returns its exit code when there is one.
    pub fn wait(&mut self) -> Option<i32> {
        self.child.wait().ok().and_then(|s| s.code())
    }

    /// SIGTERM first so the sidecar can flush its stores (it handles SIGTERM), SIGKILL
    /// after `grace` if it is still there.
    pub fn stop(&mut self, grace: Duration) {
        if self.exited().is_some() {
            return;
        }
        #[cfg(unix)]
        {
            let _ = Command::new("kill").arg("-TERM").arg(self.child.id().to_string()).status();
        }
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if self.exited().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_lookup_order_and_plain_errors() {
        let dir = std::env::temp_dir().join(format!("maka-node-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let bundled = dir.join("node");
        fs::write(&bundled, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Not executable (shell-check's placeholder copied by the dev loop): it must
            // lose to node on PATH, and alone it is "not found".
            fs::set_permissions(&bundled, fs::Permissions::from_mode(0o644)).unwrap();
            let path_dir = dir.join("pathbin");
            fs::create_dir_all(&path_dir).unwrap();
            let on_path = path_dir.join("node");
            fs::write(&on_path, b"#!/bin/sh\n").unwrap();
            fs::set_permissions(&on_path, fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(find_node(Some(&dir), None, Some(path_dir.to_str().unwrap())).unwrap(), on_path);
            assert!(find_node(Some(&dir), None, None).is_err());
            fs::set_permissions(&bundled, fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(find_node(Some(&dir), None, None).unwrap(), bundled);
        let explicit = dir.join("other");
        fs::write(&explicit, b"").unwrap();
        assert_eq!(find_node(Some(&dir), Some(explicit.to_str().unwrap()), None).unwrap(), explicit);
        let missing = find_node(Some(&dir.join("nope")), None, Some("/definitely/not/here")).unwrap_err();
        assert!(missing.contains("tried"), "{missing}");
        assert!(missing.contains("MAKA_NODE"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn repo_lookup_prefers_env_then_resources_then_the_checkout() {
        let dir = std::env::temp_dir().join(format!("maka-repo-{}", std::process::id()));
        fs::create_dir_all(dir.join("sidecar")).unwrap();
        fs::write(dir.join("sidecar").join("index.js"), b"").unwrap();
        fs::write(dir.join("package.json"), b"{}").unwrap();
        assert_eq!(find_repo(None, Some(dir.to_str().unwrap())).unwrap(), dir.canonicalize().unwrap());
        let not_a_repo = dir.join("empty");
        fs::create_dir_all(&not_a_repo).unwrap();
        // Falls through to this crate's own checkout, which has the sidecar.
        let found = find_repo(Some(&not_a_repo), None).unwrap();
        assert!(found.join("sidecar").join("index.js").is_file());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn free_port_is_ephemeral() {
        let p = free_port().unwrap();
        assert!(p >= 1024);
    }
}
