//! server/static.ts: the static frontend build, indexed once at start, served with the .br / .gz siblings
//! scripts/compress-static.mjs wrote next to each file. Hashed bundle files are immutable; everything else
//! revalidates by ETag (sw.js must, or a new service worker would never be seen).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use std::{fs, io};

use bytes::Bytes;
use hyper::header::{
    ACCEPT_ENCODING, ALLOW, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, ETAG, IF_NONE_MATCH, VARY,
};
use hyper::{Method, Request, Response, StatusCode};

use crate::http::{Body, full};

fn content_type(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

struct Entry {
    body: Bytes,
    br: Option<Bytes>,
    gz: Option<Bytes>,
    ctype: &'static str,
    etag: String,
    cache: &'static str,
}

/// ponytail: the whole build lives in memory (out/ is 4.6 MB with its .br/.gz siblings, 2026-11-06), so a
/// request is a refcount bump and never touches the disk. Stream from disk if out/ ever grows past ~50 MB.
pub struct Static {
    files: HashMap<String, Arc<Entry>>,
}

fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) -> io::Result<()> {
    for d in fs::read_dir(dir)? {
        let d = d?;
        let t = d.file_type()?;
        let p = d.path();
        if t.is_dir() {
            walk(&p, out)?;
        } else if t.is_file() && !matches!(p.extension().and_then(|e| e.to_str()), Some("br" | "gz")) {
            out.push(p);
        }
    }
    Ok(())
}

/// A sibling of zero bytes counts as absent, as `e.br &&` does in static.ts.
fn sibling(file: &Path, ext: &str) -> io::Result<Option<Bytes>> {
    let mut name = file.as_os_str().to_owned();
    name.push(ext);
    match fs::read(&name) {
        Ok(b) if !b.is_empty() => Ok(Some(Bytes::from(b))),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

impl Static {
    /// A missing root (no frontend build) loads nothing: every page then answers the bare 404 and the API still runs.
    pub fn load(root: &Path) -> io::Result<Self> {
        if !root.try_exists()? {
            crate::logger::warn("http", format_args!("no static build at {}", root.display()));
            return Ok(Static { files: HashMap::new() });
        }
        let mut paths = Vec::new();
        walk(root, &mut paths)?;
        let mut files = HashMap::new();
        for file in paths {
            let meta = fs::metadata(&file)?;
            let rel = file.strip_prefix(root).expect("walked under root");
            let url = format!(
                "/{}",
                rel.iter().map(|s| s.to_string_lossy()).collect::<Vec<_>>().join("/")
            );
            let mtime_ms = meta.modified()?.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
            let e = Arc::new(Entry {
                body: Bytes::from(fs::read(&file)?),
                br: sibling(&file, ".br")?,
                gz: sibling(&file, ".gz")?,
                ctype: content_type(file.extension().and_then(|e| e.to_str()).unwrap_or("")),
                etag: format!("W/\"{:x}-{:x}\"", meta.len(), mtime_ms),
                cache: if url.starts_with("/assets/") {
                    "public, max-age=31536000, immutable"
                } else if url.ends_with(".html") {
                    "no-cache"
                } else {
                    "public, max-age=0"
                },
            });
            // /index.html answers /, /brygady.html answers /brygady
            if let Some(dir) = url.strip_suffix("index.html").filter(|_| url.ends_with("/index.html")) {
                let alias = if dir.len() > 1 { &dir[..dir.len() - 1] } else { dir };
                files.insert(alias.to_string(), e.clone());
            } else if let Some(stem) = url.strip_suffix(".html") {
                files.insert(stem.to_string(), e.clone());
            }
            files.insert(url, e);
        }
        Ok(Static { files })
    }

    pub fn serve(&self, req: &Request<hyper::body::Incoming>, raw_path: &str) -> Response<Body> {
        let head = req.method() == Method::HEAD;
        if req.method() != Method::GET && !head {
            return Response::builder()
                .status(StatusCode::METHOD_NOT_ALLOWED)
                .header(ALLOW, "GET, HEAD")
                .body(full(Bytes::new()))
                .expect("static response");
        }
        let Some(path) = decode_uri_component(raw_path) else {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(full(Bytes::new()))
                .expect("static response");
        };
        let (e, status) = match (self.files.get(&path), self.files.get("/404")) {
            (Some(e), _) => (e, StatusCode::OK),
            (None, Some(nf)) => (nf, StatusCode::NOT_FOUND),
            (None, None) => {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(full(Bytes::new()))
                    .expect("static response");
            }
        };
        let mut res = Response::builder()
            .status(status)
            .header(CONTENT_TYPE, e.ctype)
            .header(CACHE_CONTROL, e.cache)
            .header(ETAG, &e.etag);
        if e.br.is_some() || e.gz.is_some() {
            res = res.header(VARY, "Accept-Encoding");
        }
        if status == StatusCode::OK
            && req
                .headers()
                .get(IF_NONE_MATCH)
                .is_some_and(|v| v.as_bytes() == e.etag.as_bytes())
        {
            return res
                .status(StatusCode::NOT_MODIFIED)
                .body(full(Bytes::new()))
                .expect("static response");
        }
        let ae = req
            .headers()
            .get(ACCEPT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let (body, enc) = match (&e.br, &e.gz) {
            (Some(b), _) if has_word(ae, "br") => (b, Some("br")),
            (_, Some(g)) if has_word(ae, "gzip") => (g, Some("gzip")),
            _ => (&e.body, None),
        };
        if let Some(enc) = enc {
            res = res.header(CONTENT_ENCODING, enc);
        }
        res.header(CONTENT_LENGTH, body.len())
            .body(full(if head { Bytes::new() } else { body.clone() }))
            .expect("static response")
    }
}

/// `/\bword\b/.test(s)`: `word` with no ASCII word character on either side.
fn has_word(s: &str, word: &str) -> bool {
    let w = |c: Option<u8>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_');
    s.match_indices(word).any(|(i, _)| {
        let b = s.as_bytes();
        !w(i.checked_sub(1).map(|j| b[j])) && !w(b.get(i + word.len()).copied())
    })
}

/// JS decodeURIComponent: `None` where it throws (a `%` without two hex digits, bytes that are not UTF-8).
pub fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            // from_str_radix alone would take "+1"
            let hex = b.get(i + 1..i + 3).filter(|h| h.iter().all(u8::is_ascii_hexdigit))?;
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_matches_js() {
        assert_eq!(decode_uri_component("/a%20b").as_deref(), Some("/a b"));
        assert_eq!(decode_uri_component("/%C5%BC").as_deref(), Some("/ż"));
        assert_eq!(decode_uri_component("/a%2Fb").as_deref(), Some("/a/b"));
        assert_eq!(decode_uri_component("/%"), None);
        assert_eq!(decode_uri_component("/%4"), None);
        assert_eq!(decode_uri_component("/%zz"), None);
        assert_eq!(decode_uri_component("/%+1"), None);
        assert_eq!(decode_uri_component("/%C5"), None);
        assert_eq!(decode_uri_component("/%ED%A0%80"), None);
    }

    #[test]
    fn missing_root_loads_nothing() {
        let s = Static::load(Path::new("/nonexistent/unimaps-out")).unwrap();
        assert!(s.files.is_empty());
    }

    #[test]
    fn word_boundaries() {
        assert!(has_word("gzip, deflate, br", "br"));
        assert!(has_word("br;q=0", "br"));
        assert!(!has_word("brotli", "br"));
        assert!(!has_word("x-gzip2", "gzip"));
        assert!(has_word("x-gzip", "gzip"));
        assert!(!has_word("", "br"));
    }
}
