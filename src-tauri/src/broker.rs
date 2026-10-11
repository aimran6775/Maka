//! The credential broker: the session-scoped handle the shell gives the sidecar.
//!
//! At launch the shell makes a random token and a Unix socket in a 0700 directory, and
//! passes both to the sidecar as `MAKA_CREDENTIALS_SOCKET` and `MAKA_CREDENTIALS_TOKEN`.
//! The sidecar's `keys.js` sends one request per connection, one line:
//!
//! ```text
//! <token> GET  <name>
//! <token> SET  <name> <base64 value>
//! <token> DEL  <name>
//! <token> LIST
//! ```
//!
//! and reads one line back: `OK`, `OK <base64 value>` (GET), `OK <name,name,…>` (LIST),
//! `NONE` (GET of a missing name) or `ERR <message>`. Values travel base64-encoded so a
//! newline in a token can never break the framing. The token dies with the session, the
//! socket is removed on exit, and a wrong token is refused before any store access.
//!
//! Phase 4 step 18 adds one op on the same socket, so computer control never needs a port:
//!
//! ```text
//! <token> COMPUTER <action> <base64 json>   ->   OK <base64 json> | ERR <message>
//! ```
//!
//! answered by the `ComputerHost` the shell passes to `start` (computer.rs on macOS; the
//! `NoComputer` host says it is not available).

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::credentials::Store;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Get(String),
    Set(String, String),
    Del(String),
    List,
    /// Phase 4 step 18: `COMPUTER <action> <base64 json>`.
    Computer(String, String),
}

/// What answers a `COMPUTER` request: the shell's computer control, or nothing.
pub trait ComputerHost: Send + Sync {
    /// Returns the JSON answer (as text) or an error message for `ERR`.
    fn handle(&self, action: &str, request_json: &str) -> Result<String, String>;
}

/// No computer control on this host (tests, platforms without it).
pub struct NoComputer;

impl ComputerHost for NoComputer {
    fn handle(&self, _action: &str, _request_json: &str) -> Result<String, String> {
        Err("computer control is not available in this shell".into())
    }
}

/// Parses one request line (the token already split off). Errors are messages for `ERR`.
pub fn parse_request(line: &str) -> Result<Request, String> {
    let mut parts = line.split_whitespace();
    let op = parts.next().ok_or("empty request")?;
    match op {
        "GET" => Ok(Request::Get(parts.next().ok_or("GET needs a name")?.to_string())),
        "DEL" => Ok(Request::Del(parts.next().ok_or("DEL needs a name")?.to_string())),
        "LIST" => Ok(Request::List),
        "SET" => {
            let name = parts.next().ok_or("SET needs a name")?.to_string();
            let b64 = parts.next().ok_or("SET needs a base64 value")?;
            let value = base64_decode(b64).ok_or("SET value is not valid base64")?;
            Ok(Request::Set(name, String::from_utf8(value).map_err(|_| "SET value is not UTF-8")?))
        }
        "COMPUTER" => {
            let action = parts.next().ok_or("COMPUTER needs an action")?.to_string();
            let b64 = parts.next().ok_or("COMPUTER needs a base64 json request")?;
            let value = base64_decode(b64).ok_or("COMPUTER request is not valid base64")?;
            Ok(Request::Computer(action, String::from_utf8(value).map_err(|_| "COMPUTER request is not UTF-8")?))
        }
        other => Err(format!("unknown op {other}")),
    }
}

/// Answers one already-authenticated request.
pub fn handle(store: &dyn Store, computer: &dyn ComputerHost, req: Request) -> String {
    let r = match req {
        Request::Get(name) => store.get(&name).map(|v| match v {
            Some(v) => format!("OK {}", base64_encode(v.as_bytes())),
            None => "NONE".to_string(),
        }),
        Request::Set(name, value) => store.set(&name, &value).map(|_| "OK".to_string()),
        Request::Del(name) => store.delete(&name).map(|_| "OK".to_string()),
        Request::List => store.list().map(|names| format!("OK {}", names.join(","))),
        Request::Computer(action, json) => computer.handle(&action, &json).map(|answer| format!("OK {}", base64_encode(answer.as_bytes()))),
    };
    match r {
        Ok(line) => line,
        Err(e) => format!("ERR {}", e.replace('\n', " ")),
    }
}

/// The full line: token check first, then the request.
pub fn answer(store: &dyn Store, computer: &dyn ComputerHost, token: &str, line: &str) -> String {
    let line = line.trim_end_matches(['\r', '\n']);
    let (given, rest) = match line.split_once(' ') {
        Some(x) => x,
        None => return "ERR missing token".to_string(),
    };
    if !constant_time_eq(given.as_bytes(), token.as_bytes()) {
        return "ERR bad token".to_string();
    }
    match parse_request(rest) {
        Ok(req) => handle(store, computer, req),
        Err(e) => format!("ERR {e}"),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn random_token() -> String {
    // 32 bytes from the OS: /dev/urandom on unix. No crate needed.
    let mut buf = [0u8; 32];
    #[cfg(unix)]
    {
        use std::io::Read;
        if let Ok(mut f) = fs::File::open("/dev/urandom") {
            let _ = f.read_exact(&mut buf);
        }
    }
    // Mix in time and pid so a failed read never yields all zeros.
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let salt = t.to_le_bytes();
    let pid = std::process::id().to_le_bytes();
    for (i, b) in buf.iter_mut().enumerate() {
        *b ^= salt[i % salt.len()] ^ pid[i % pid.len()];
    }
    hex(&buf)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.trim().as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let val = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 {
            return None;
        }
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            let v = if c == b'=' && i >= 4 - pad { 0 } else { val(c)? };
            n = (n << 6) | v;
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// A running broker: the socket path and token to hand the sidecar.
pub struct Broker {
    pub socket: PathBuf,
    pub token: String,
    dir: PathBuf,
}

impl Broker {
    pub fn env(&self) -> Vec<(String, String)> {
        vec![("MAKA_CREDENTIALS_SOCKET".into(), self.socket.display().to_string()), ("MAKA_CREDENTIALS_TOKEN".into(), self.token.clone())]
    }
    /// Removes the socket and its directory (the token is useless without the socket).
    pub fn close(&self) {
        let _ = fs::remove_file(&self.socket);
        let _ = fs::remove_dir(&self.dir);
    }
}

/// Starts the broker on a fresh socket under `base` (a 0700 directory per session) and
/// serves it from a thread for the life of the process.
#[cfg(unix)]
pub fn start(store: Arc<dyn Store>, computer: Arc<dyn ComputerHost>, base: &Path) -> Result<Broker, String> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    let dir = base.join(format!("maka-{}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let socket = dir.join("credentials.sock");
    let _ = fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).map_err(|e| format!("cannot listen on {}: {e}", socket.display()))?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    let token = random_token();
    let thread_token = token.clone();
    std::thread::Builder::new()
        .name("maka-credentials".into())
        .spawn(move || {
            for conn in listener.incoming() {
                let Ok(stream) = conn else { continue };
                let store = store.clone();
                let computer = computer.clone();
                let token = thread_token.clone();
                std::thread::spawn(move || serve_one(stream, &*store, &*computer, &token));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Broker { socket, token, dir })
}

#[cfg(unix)]
fn serve_one(stream: std::os::unix::net::UnixStream, store: &dyn Store, computer: &dyn ComputerHost, token: &str) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let mut reader = BufReader::new(stream.try_clone().expect("clone socket"));
    let mut line = String::new();
    let reply = match reader.read_line(&mut line) {
        Ok(0) => return,
        Ok(_) if line.len() > 128 * 1024 => "ERR request too long".to_string(),
        Ok(_) => answer(store, computer, token, &line),
        Err(e) => format!("ERR read: {e}"),
    };
    let mut w = stream;
    let _ = w.write_all(reply.as_bytes());
    let _ = w.write_all(b"\n");
    let _ = w.flush();
}

#[cfg(not(unix))]
pub fn start(_store: Arc<dyn Store>, _computer: Arc<dyn ComputerHost>, _base: &Path) -> Result<Broker, String> {
    Err("the credential broker needs Unix domain sockets".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{file::FileStore, Indexed};

    #[test]
    fn base64_round_trips() {
        for s in ["", "a", "ab", "abc", "sk-ant-api03-ABC/+=\n{json}"] {
            assert_eq!(base64_decode(&base64_encode(s.as_bytes())).unwrap(), s.as_bytes());
        }
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
        assert!(base64_decode("###").is_none());
    }

    #[test]
    fn requests_parse_and_the_token_gates_everything() {
        let dir = std::env::temp_dir().join(format!("maka-broker-{}", std::process::id()));
        let store = Indexed(FileStore::new(dir.join("ks.json")));
        let none = NoComputer;
        assert_eq!(answer(&store, &none, "t0k", "nope GET ANTHROPIC_API_KEY"), "ERR bad token");
        assert_eq!(answer(&store, &none, "t0k", "GET"), "ERR missing token");
        assert_eq!(answer(&store, &none, "t0k", "t0k GET ANTHROPIC_API_KEY\n"), "NONE");
        assert_eq!(answer(&store, &none, "t0k", &format!("t0k SET ANTHROPIC_API_KEY {}", base64_encode(b"sk-1"))), "OK");
        assert_eq!(answer(&store, &none, "t0k", "t0k GET ANTHROPIC_API_KEY"), format!("OK {}", base64_encode(b"sk-1")));
        assert_eq!(answer(&store, &none, "t0k", "t0k LIST"), "OK ANTHROPIC_API_KEY");
        assert_eq!(answer(&store, &none, "t0k", "t0k SET x ***"), "ERR SET value is not valid base64");
        assert_eq!(answer(&store, &none, "t0k", "t0k FROB x"), "ERR unknown op FROB");
        assert_eq!(answer(&store, &none, "t0k", "t0k DEL ANTHROPIC_API_KEY"), "OK");
        assert_eq!(answer(&store, &none, "t0k", "t0k LIST"), "OK ");
        assert!(parse_request("SET only_name").is_err());
        // Phase 4 step 18: the COMPUTER op parses and is answered by the host.
        assert_eq!(parse_request(&format!("COMPUTER status {}", base64_encode(b"{\"action\":\"status\"}"))).unwrap(), Request::Computer("status".into(), "{\"action\":\"status\"}".into()));
        assert!(parse_request("COMPUTER status").is_err());
        assert_eq!(answer(&store, &none, "t0k", &format!("t0k COMPUTER status {}", base64_encode(b"{}"))), "ERR computer control is not available in this shell");
        struct Echo;
        impl ComputerHost for Echo {
            fn handle(&self, action: &str, json: &str) -> Result<String, String> {
                Ok(format!("{{\"action\":\"{action}\",\"got\":{json}}}"))
            }
        }
        assert_eq!(answer(&store, &Echo, "t0k", &format!("t0k COMPUTER click {}", base64_encode(b"{\"x\":1}"))), format!("OK {}", base64_encode(b"{\"action\":\"click\",\"got\":{\"x\":1}}")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_socket_serves_one_request_per_connection() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixStream;
        let dir = std::env::temp_dir().join(format!("maka-broker-sock-{}", std::process::id()));
        let store: Arc<dyn Store> = Arc::new(Indexed(FileStore::new(dir.join("ks.json"))));
        let broker = start(store, Arc::new(NoComputer), &dir).unwrap();
        let ask = |line: String| {
            let mut s = UnixStream::connect(&broker.socket).unwrap();
            s.write_all(line.as_bytes()).unwrap();
            s.write_all(b"\n").unwrap();
            let mut r = String::new();
            BufReader::new(s).read_line(&mut r).unwrap();
            r.trim_end().to_string()
        };
        assert_eq!(ask(format!("{} SET resend {}", broker.token, base64_encode(b"re_1"))), "OK");
        assert_eq!(ask(format!("{} GET resend", broker.token)), format!("OK {}", base64_encode(b"re_1")));
        assert_eq!(ask("wrong GET resend".into()), "ERR bad token");
        assert_eq!(broker.env()[0].0, "MAKA_CREDENTIALS_SOCKET");
        broker.close();
        assert!(!broker.socket.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
