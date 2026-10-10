//! A minimal HTTP/1.1 client for the sidecar on 127.0.0.1 (plain HTTP, JSON bodies).
//!
//! The shell only ever talks to its own sidecar on the loopback interface, so a TLS-capable
//! client would be dead weight. One request per connection (`Connection: close`), a
//! connect and read timeout, content-length and chunked bodies. Nothing else.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub path: String,
}

/// Splits `http://host:port/path?query` into its parts. Only `http` is accepted.
pub fn parse_url(url: &str) -> Result<Target, String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("only http:// URLs are supported, got {url}"))?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().map_err(|_| format!("bad port in {url}"))?),
        None => (authority, 80),
    };
    if host.is_empty() {
        return Err(format!("missing host in {url}"));
    }
    Ok(Target { host: host.to_string(), port, path: path.to_string() })
}

pub fn get(url: &str, timeout: Duration) -> Result<Response, String> {
    request("GET", url, None, &[], timeout)
}

/// A JSON POST. `token` is the sidecar's per-boot token (safety M4): every mutating route
/// refuses a request without it in `x-maka-token`.
pub fn post_json(url: &str, body: &str, token: Option<&str>, timeout: Duration) -> Result<Response, String> {
    let headers: Vec<(&str, &str)> = token.map(|t| vec![(TOKEN_HEADER, t)]).unwrap_or_default();
    request("POST", url, Some(body), &headers, timeout)
}

pub const TOKEN_HEADER: &str = "x-maka-token";

/// Builds the request text the client sends (pure, so the host tests can check it).
pub fn request_text(method: &str, t: &Target, body: Option<&str>, headers: &[(&str, &str)]) -> String {
    let body = body.unwrap_or("");
    let mut req = format!(
        "{method} {} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\nAccept: application/json\r\n",
        t.path, t.host, t.port
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    if method != "GET" {
        req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
    }
    req.push_str("\r\n");
    req.push_str(body);
    req
}

pub fn request(method: &str, url: &str, body: Option<&str>, headers: &[(&str, &str)], timeout: Duration) -> Result<Response, String> {
    let t = parse_url(url)?;
    let addr: SocketAddr = (t.host.as_str(), t.port)
        .to_socket_addrs()
        .map_err(|e| format!("resolve {}: {e}", t.host))?
        .next()
        .ok_or_else(|| format!("no address for {}", t.host))?;
    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("connect {addr}: {e}"))?;
    stream.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    let req = request_text(method, &t, body, headers);
    stream.write_all(req.as_bytes()).map_err(|e| format!("write: {e}"))?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| format!("read: {e}"))?;
    parse_response(&raw)
}

/// Parses a complete HTTP/1.1 response (status line, headers, body; chunked or sized).
pub fn parse_response(raw: &[u8]) -> Result<Response, String> {
    let split = find(raw, b"\r\n\r\n").ok_or("malformed response: no header terminator")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let body_raw = &raw[split + 4..];
    let mut lines = head.lines();
    let status_line = lines.next().ok_or("malformed response: empty")?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| format!("malformed status line: {status_line}"))?;
    let mut chunked = false;
    let mut length: Option<usize> = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim().to_ascii_lowercase();
            let v = v.trim();
            if k == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            } else if k == "content-length" {
                length = v.parse::<usize>().ok();
            }
        }
    }
    let body = if chunked {
        dechunk(body_raw)?
    } else if let Some(n) = length {
        body_raw[..n.min(body_raw.len())].to_vec()
    } else {
        body_raw.to_vec()
    };
    Ok(Response { status, body: String::from_utf8_lossy(&body).into_owned() })
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn dechunk(mut raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let eol = find(raw, b"\r\n").ok_or("malformed chunk size")?;
        let size_text = String::from_utf8_lossy(&raw[..eol]);
        let size_text = size_text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| format!("bad chunk size {size_text}"))?;
        raw = &raw[eol + 2..];
        if size == 0 {
            return Ok(out);
        }
        if raw.len() < size {
            return Err("truncated chunk".into());
        }
        out.extend_from_slice(&raw[..size]);
        raw = &raw[size..];
        if raw.starts_with(b"\r\n") {
            raw = &raw[2..];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_urls() {
        assert_eq!(parse_url("http://127.0.0.1:8790/api/state").unwrap(), Target { host: "127.0.0.1".into(), port: 8790, path: "/api/state".into() });
        assert_eq!(parse_url("http://localhost").unwrap(), Target { host: "localhost".into(), port: 80, path: "/".into() });
        assert!(parse_url("https://x/").is_err());
        assert!(parse_url("http://:1/").is_err());
    }

    #[test]
    fn a_post_carries_the_token_and_json_headers() {
        let t = parse_url("http://127.0.0.1:8790/api/away").unwrap();
        let req = request_text("POST", &t, Some("{\"away\":true}"), &[(TOKEN_HEADER, "abc")]);
        assert!(req.starts_with("POST /api/away HTTP/1.1\r\nHost: 127.0.0.1:8790\r\n"));
        assert!(req.contains("\r\nx-maka-token: abc\r\n"));
        assert!(req.contains("\r\nContent-Type: application/json\r\nContent-Length: 13\r\n"));
        assert!(req.ends_with("\r\n\r\n{\"away\":true}"));
        let get = request_text("GET", &t, None, &[]);
        assert!(!get.contains("x-maka-token"));
        assert!(!get.contains("Content-Type"));
    }

    #[test]
    fn parses_sized_and_chunked_bodies() {
        let r = parse_response(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}extra").unwrap();
        assert_eq!(r, Response { status: 200, body: "{}".into() });
        let c = parse_response(b"HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n").unwrap();
        assert_eq!(c, Response { status: 404, body: "abcde".into() });
        assert!(parse_response(b"garbage").is_err());
    }
}
