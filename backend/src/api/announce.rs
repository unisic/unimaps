//! GET /api/announce/<name>: one pre-recorded GZM stop announcement ("Nastepny przystanek: <name>"),
//! `<KB_GZM_ANNOUNCE_DIR>/<name>.mp3`, read from disk per request (the set is ~400 MB, far too much for the in-memory
//! static build); the OS page cache and the browser's HTTP cache are the only caches. 404 while `KB_GZM=0`.

use std::io::ErrorKind;
use std::path::Path;

use hyper::Response;
use hyper::header::{CACHE_CONTROL, CONTENT_TYPE, HeaderValue};
use tokio::io::AsyncReadExt;

use super::ApiRequest;
use crate::api_helpers::{bad_request, internal_error, not_found};
use crate::config::{GZM_ANNOUNCE_DIR, GZM_ENABLED};
use crate::http::{Body, full};
use crate::rate_limit::{allow_request, too_many_requests};

/// the largest real file is 580 KB
const MAX_FILE: u64 = 1 << 20;

pub async fn get_owned(req: &ApiRequest) -> Response<Body> {
    if !allow_request(&req.ip(), 1.0) {
        return too_many_requests();
    }
    if !*GZM_ENABLED {
        return not_found("Not found");
    }
    serve(Path::new(&*GZM_ANNOUNCE_DIR), &req.param).await
}

fn missing() -> Response<Body> {
    let mut res = not_found("Not found");
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `get_owned` past its gates, with the directory passed in.
async fn serve(dir: &Path, name: &str) -> Response<Body> {
    // the only gate against path traversal: this charset has no '/', '.' or '%'
    if !(1..=96).contains(&name.len())
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return bad_request("Invalid announcement name");
    }
    let bytes = async {
        let file = tokio::fs::File::open(dir.join(format!("{name}.mp3"))).await?;
        let meta = file.metadata().await?;
        if !meta.is_file() || meta.len() > MAX_FILE {
            return Ok(None);
        }
        let mut buf = Vec::with_capacity(meta.len() as usize);
        // take: a file growing after the size check still cannot pass MAX_FILE
        file.take(MAX_FILE).read_to_end(&mut buf).await?;
        Ok::<_, std::io::Error>(Some(buf))
    };
    let buf = match bytes.await {
        Ok(Some(buf)) => buf,
        Ok(None) => return missing(),
        Err(err) if err.kind() == ErrorKind::NotFound => return missing(),
        Err(err) => return internal_error("announce", err),
    };
    let mut res = Response::new(full(buf));
    let h = res.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("audio/mpeg"));
    h.insert(CACHE_CONTROL, HeaderValue::from_static("public, max-age=604800"));
    res
}

#[cfg(test)]
mod tests {
    use http_body_util::BodyExt;
    use hyper::StatusCode;

    use super::*;

    #[tokio::test]
    async fn serves_only_a_small_file_with_a_valid_name() {
        let dir = std::env::temp_dir().join(format!("unimaps-announce-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join("p-next.mp3"), b"ID3\x04abc").expect("file");
        std::fs::File::create(dir.join("big.mp3"))
            .and_then(|f| f.set_len(MAX_FILE + 1))
            .expect("big file");
        std::fs::write(dir.join("secret.mp3"), b"x").expect("file");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).expect("sub");

        let res = serve(&dir, "p-next").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[CONTENT_TYPE], "audio/mpeg");
        assert_eq!(res.headers()[CACHE_CONTROL], "public, max-age=604800");
        let body = res.into_body().collect().await.expect("body").to_bytes();
        assert_eq!(&body[..], b"ID3\x04abc");

        for name in ["unknown", "big"] {
            let res = serve(&dir, name).await;
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{name}");
            assert_eq!(res.headers()[CACHE_CONTROL], "no-store", "{name}");
        }
        assert_eq!(serve(&dir.join("nope"), "p-next").await.status(), StatusCode::NOT_FOUND);
        let long = "a".repeat(97);
        for name in ["../x", "../secret", "P-next", "p_next", "p-next.mp3", "", long.as_str()] {
            assert_eq!(serve(&sub, name).await.status(), StatusCode::BAD_REQUEST, "{name:?}");
        }
        assert_eq!(serve(&dir, &"a".repeat(96)).await.status(), StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
