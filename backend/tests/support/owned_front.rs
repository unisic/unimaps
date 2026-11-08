//! The owned-mode front (`App::owned`, no Node) behind main.rs's accept loop on 127.0.0.1:0, and a raw HTTP/1.1
//! client: one connection per request, the head written verbatim, so a test can leave Host out.

use std::io::{Read as _, Write as _};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;
use tokio::runtime::Runtime;
use unimaps::http::{App, handle};
use unimaps::static_files::Static;

/// A dead upstream must answer before this, never hang a test.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Front {
    _rt: Runtime,
    pub addr: SocketAddr,
}

pub struct Res {
    pub status: u16,
    pub head: String,
    pub body: String,
    pub bytes: Vec<u8>,
}

impl Res {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.head.lines().skip(1).find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim())
        })
    }
}

impl Front {
    /// The owned front over the static build in `out`, on its own runtime: the server and the singletons' tasks
    /// outlive every test of the binary.
    pub fn serve(out: &Path) -> Front {
        let app = Arc::new(App::owned(Static::load(out).unwrap()));
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let addr = rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                loop {
                    let Ok((stream, peer)) = listener.accept().await else {
                        continue;
                    };
                    let app = app.clone();
                    tokio::spawn(async move {
                        let svc = service_fn(|req| handle(&app, peer, req));
                        let _ = http1::Builder::new()
                            .timer(TokioTimer::new())
                            .serve_connection(TokioIo::new(stream), svc)
                            .await;
                    });
                }
            });
            addr
        });
        Front { _rt: rt, addr }
    }

    pub fn raw(&self, head: &str, body: &[u8]) -> Res {
        let mut s = TcpStream::connect(self.addr).unwrap();
        s.set_read_timeout(Some(READ_TIMEOUT)).unwrap();
        s.write_all(head.as_bytes()).unwrap();
        s.write_all(body).unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).unwrap();
        let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&buf[..split]).into_owned();
        let bytes = buf[split + 4..].to_vec();
        let status = head.split(' ').nth(1).unwrap().parse().unwrap();
        Res {
            status,
            head,
            body: String::from_utf8_lossy(&bytes).into_owned(),
            bytes,
        }
    }

    /// `method path` with Host, Connection: close, Content-Length and `headers`.
    pub fn request(&self, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Res {
        let extra: String = headers.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
        self.raw(
            &format!(
                "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n",
                body.len()
            ),
            body,
        )
    }
}
