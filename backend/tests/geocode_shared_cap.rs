//! server/api/geocode/route.ts keeps ONE `inFlight` counter (MAX_IN_FLIGHT = 4) for every city of the process. In
//! the split stage BB geocodes go to Node and zbiorkom ones stay in Rust, so the front must still keep the public
//! Photon host at 4 requests in flight across both: a fake Node that holds its geocodes, a Photon that never answers.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use tokio::net::TcpListener;
use tokio::sync::watch;
use unimaps::http::{App, handle};
use unimaps::static_files::Static;

struct Rig {
    front: SocketAddr,
    /// geocodes that reached the fake Node
    node: Arc<AtomicUsize>,
    /// connections Photon accepted
    photon: Arc<AtomicUsize>,
    release_node: watch::Sender<bool>,
    release_photon: watch::Sender<bool>,
}

async fn rig() -> Rig {
    let dir = std::env::temp_dir().join(format!("unimaps-geocode-cap-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("404.html"), "<!doctype html>").unwrap();

    let photon_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let photon_addr = photon_l.local_addr().unwrap();
    // SAFETY: the one test of this binary, before anything reads the environment
    unsafe {
        std::env::set_var("KB_OUTPUT_DIR", dir.join("output"));
        std::env::set_var("KB_GEOCODER_URL", format!("http://{photon_addr}/api/"));
        std::env::set_var("KB_OSRM_URL", "off");
        std::env::set_var("KB_LOG_LEVEL", "error");
    }
    let (release_photon, photon_rx) = watch::channel(false);
    let photon = Arc::new(AtomicUsize::new(0));
    let accepted = photon.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = photon_l.accept().await else {
                continue;
            };
            accepted.fetch_add(1, Ordering::SeqCst);
            let mut rx = photon_rx.clone();
            tokio::spawn(async move {
                let _ = rx.wait_for(|v| *v).await;
                drop(stream);
            });
        }
    });

    let (release_node, node_rx) = watch::channel(false);
    let node = Arc::new(AtomicUsize::new(0));
    let node_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let node_port = node_l.local_addr().unwrap().port();
    let seen = node.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = node_l.accept().await else {
                continue;
            };
            let (seen, rx) = (seen.clone(), node_rx.clone());
            tokio::spawn(async move {
                let svc = service_fn(move |req: Request<Incoming>| {
                    let (seen, mut rx) = (seen.clone(), rx.clone());
                    async move {
                        seen.fetch_add(1, Ordering::SeqCst);
                        // a held geocode: Node's own Photon request in progress
                        if req.uri().query().is_some_and(|q| q.contains("hold")) {
                            let _ = rx.wait_for(|v| *v).await;
                        }
                        Ok::<_, Infallible>(
                            Response::builder()
                                .header("content-type", "application/json")
                                .header("cache-control", "public, max-age=3600")
                                .body(Full::new(Bytes::from_static(br#"{"results":[]}"#)))
                                .unwrap(),
                        )
                    }
                });
                let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), svc).await;
            });
        }
    });

    let front_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let front = front_l.local_addr().unwrap();
    let app = Arc::new(App::new(Static::load(&out).unwrap(), node_port, true));
    tokio::spawn(async move {
        loop {
            let Ok((stream, peer)) = front_l.accept().await else {
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
    Rig {
        front,
        node,
        photon,
        release_node,
        release_photon,
    }
}

static IP: AtomicUsize = AtomicUsize::new(0);

/// (status, body) of `method path` from its own client address (the per-IP bucket never decides here)
async fn send(front: SocketAddr, method: &'static str, path: String) -> (u16, Bytes) {
    let ip = format!("10.7.0.{}", IP.fetch_add(1, Ordering::SeqCst) + 1);
    let client = Client::builder(TokioExecutor::new()).build_http::<Full<Bytes>>();
    let req = Request::builder()
        .method(method)
        .uri(format!("http://{front}{path}"))
        .header("x-forwarded-for", ip)
        .body(Full::new(Bytes::new()))
        .unwrap();
    let res = tokio::time::timeout(Duration::from_secs(20), client.request(req))
        .await
        .unwrap()
        .unwrap();
    let status = res.status().as_u16();
    (status, res.into_body().collect().await.unwrap().to_bytes())
}

async fn until(n: &AtomicUsize, want: usize) {
    for _ in 0..500 {
        if n.load(Ordering::SeqCst) >= want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("waited for {want}, got {}", n.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_in_flight_cap_over_bb_and_zbiorkom_geocodes() {
    let r = rig().await;

    // four BB searches wait on Photon inside Node: TS answers the next cache miss of any city with 429
    let bb: Vec<_> = (0..4)
        .map(|i| tokio::spawn(send(r.front, "GET", format!("/api/geocode?q=hold-bb-{i}"))))
        .collect();
    until(&r.node, 4).await;
    assert_eq!(
        send(r.front, "GET", "/api/geocode?city=gzm&q=katowice".into()).await.0,
        429
    );
    assert_eq!(r.photon.load(Ordering::SeqCst), 0, "the zbiorkom search reached Photon");
    // Node's 400 comes before its in-flight check: a short q still reaches it
    let seen = r.node.load(Ordering::SeqCst);
    assert_eq!(send(r.front, "GET", "/api/geocode?q=ab".into()).await.0, 200);
    assert_eq!(r.node.load(Ordering::SeqCst), seen + 1);
    r.release_node.send(true).unwrap();
    for h in bb {
        assert_eq!(h.await.unwrap().0, 200);
    }

    // four zbiorkom searches wait on Photon here: a BB cache miss gets 429 and never reaches Node
    let zb: Vec<_> = (0..4)
        .map(|i| tokio::spawn(send(r.front, "GET", format!("/api/geocode?city=gzm&q=zb-search-{i}"))))
        .collect();
    until(&r.photon, 4).await;
    let seen = r.node.load(Ordering::SeqCst);
    let (status, body) = send(r.front, "GET", "/api/geocode?q=bielsko".into()).await;
    assert_eq!((status, &body[..]), (429, &br#"{"error":"Too many requests"}"#[..]));
    let (status, body) = send(r.front, "HEAD", "/api/geocode?q=bielsko".into()).await;
    assert_eq!((status, body.len()), (429, 0));
    assert_eq!(r.node.load(Ordering::SeqCst), seen, "a refused BB search reached Node");
    r.release_photon.send(true).unwrap();
    for h in zb {
        assert_eq!(h.await.unwrap().0, 502);
    }

    // every slot given back: a BB search reaches Node again
    assert_eq!(send(r.front, "GET", "/api/geocode?q=bielsko".into()).await.0, 200);
    assert_eq!(r.node.load(Ordering::SeqCst), seen + 1);
}
