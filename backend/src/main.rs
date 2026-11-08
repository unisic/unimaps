//! The Unimaps server. `unimaps` (or `unimaps serve`) listens on HOST:PORT, serves the static build
//! (KB_STATIC_DIR, default <cwd>/out) and hands the API to the Node process: started here when KB_NODE_CMD is set
//! (the Docker image), and then this process runs the zbiorkom cities (GZM booted here) and answers their API
//! requests itself; else Node is expected on 127.0.0.1:KB_NODE_PORT and keeps the whole API, zbiorkom included. `unimaps healthcheck` exits 0 when /api/health answers 2xx (Docker /
//! compose healthcheck).

use std::ffi::OsString;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use rand_core::{OsRng, RngCore};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::Semaphore;
use unimaps::{api, config, gzm, gzm_fleet, http, logger, static_files};

/// ponytail: one cap for every open connection (idle keep-alive ones included, ~8 KB of buffers each).
const MAX_CONNECTIONS: usize = 1024;
/// an idle keep-alive connection, or one still sending its headers, is closed after this (Node: 5 s idle, 60 s for
/// headers); it bounds how long one client holds a MAX_CONNECTIONS slot without sending anything
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
/// how long the Node child gets to flush its stores after SIGTERM
const CHILD_GRACE: Duration = Duration::from_secs(5);

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// `Number(process.env.PORT) || 8080`, for the integers a port can be
fn port_var(name: &str, default: u16) -> u16 {
    var(name)
        .and_then(|v| v.trim().parse().ok())
        .filter(|p| *p != 0)
        .unwrap_or(default)
}

/// server/env.ts: .env.<mode>.local, .env.local, .env.<mode>, .env; a variable already set always wins.
/// Called before any thread exists (dotenvy writes the process environment).
fn load_env_files() {
    let mode = if var("NODE_ENV").as_deref() == Some("production") {
        "production"
    } else {
        "development"
    };
    for f in [
        format!(".env.{mode}.local"),
        ".env.local".into(),
        format!(".env.{mode}"),
        ".env".into(),
    ] {
        if let Err(e) = dotenvy::from_filename(&f)
            && !e.not_found()
        {
            eprintln!("{f}: {e}");
        }
    }
}

fn healthcheck() -> ExitCode {
    let check = || -> std::io::Result<bool> {
        let addr = SocketAddr::from(([127, 0, 0, 1], port_var("PORT", 8080)));
        let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(5))?;
        s.set_read_timeout(Some(Duration::from_secs(5)))?;
        s.write_all(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")?;
        let mut head = Vec::new();
        s.take(12).read_to_end(&mut head)?;
        // "HTTP/1.1 200"
        let code = head
            .get(9..12)
            .and_then(|c| std::str::from_utf8(c).ok()?.parse::<u16>().ok());
        Ok(code.is_some_and(|c| (200..300).contains(&c)))
    };
    if check().unwrap_or(false) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn spawn_node(cmd: &str, port: u16, env: Vec<(OsString, OsString)>) -> std::io::Result<Child> {
    let mut parts = cmd.split_whitespace();
    let prog = parts
        .next()
        .ok_or_else(|| std::io::Error::other("KB_NODE_CMD is empty"))?;
    // the environment before .env loading: Node reads the .env files itself, with its own parser
    Command::new(prog)
        .args(parts)
        .env_clear()
        .envs(env)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .spawn()
}

/// KB_ZB_REMOTE for the Node child: this server's own origin, 127.0.0.1 when it listens on every interface (a
/// dual-stack `::` takes IPv4 too, while ::1 is missing when IPv6 is disabled on lo).
fn self_origin(host: &str, port: u16) -> String {
    match host.parse::<IpAddr>() {
        Ok(ip) if ip.is_unspecified() => format!("http://127.0.0.1:{port}"),
        Ok(IpAddr::V6(ip)) => format!("http://[{ip}]:{port}"),
        _ => format!("http://{host}:{port}"),
    }
}

/// 32 random bytes as hex: the secret our Node child shows in x-kb-internal.
fn internal_token() -> String {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The child's environment: the one from before .env loading, plus what makes it a sibling of this process. With
/// KB_ZB_REMOTE set, Node's startGzm/startZb are no-ops and it reads zbiorkom boards from here; the OSRM floor
/// splits the public host's rate between both processes.
fn node_env(mut env: Vec<(OsString, OsString)>, origin: String, token: &str) -> Vec<(OsString, OsString)> {
    env.push(("KB_ZB_REMOTE".into(), origin.into()));
    env.push(("KB_INTERNAL_TOKEN".into(), token.into()));
    if *config::PUBLIC_OSRM && config::env_int("KB_OSRM_MIN_INTERVAL_MS", 1100, 250) < config::PUBLIC_OSRM_SHARED_MS {
        env.push((
            "KB_OSRM_MIN_INTERVAL_MS".into(),
            config::PUBLIC_OSRM_SHARED_MS.to_string().into(),
        ));
    }
    env
}

async fn accept_loop(listener: TcpListener, app: Arc<http::App>) {
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let permit = slots.clone().acquire_owned().await.expect("semaphore never closed");
        let (stream, peer) = match listener.accept().await {
            Ok(c) => c,
            Err(e) => {
                // EMFILE and the like: back off instead of spinning
                logger::warn("http", format_args!("accept: {e}"));
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let app = app.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let svc = service_fn(|req| http::handle(&app, peer, req));
            // a client that drops mid-request is not our error
            let _ = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_TIMEOUT)
                .serve_connection(TokioIo::new(stream), svc)
                .await;
        });
    }
}

async fn serve(base_env: Vec<(OsString, OsString)>) -> ExitCode {
    let root = var("KB_STATIC_DIR").map_or_else(
        || std::env::current_dir().unwrap_or_default().join("out"),
        PathBuf::from,
    );
    let statics = match static_files::Static::load(&root) {
        Ok(s) => s,
        Err(e) => {
            logger::error("http", format_args!("static build {}: {e}", root.display()));
            return ExitCode::FAILURE;
        }
    };
    let node_port = port_var("KB_NODE_PORT", 8090);
    let (host, port) = (var("HOST").unwrap_or_else(|| "0.0.0.0".into()), port_var("PORT", 8080));
    let mut child = match var("KB_NODE_CMD").map(|cmd| {
        let token = internal_token();
        let env = node_env(base_env, self_origin(&host, port), &token);
        api::set_internal_token(token);
        spawn_node(&cmd, node_port, env)
    }) {
        None => None,
        Some(Ok(c)) => Some(c),
        Some(Err(e)) => {
            logger::error("http", format_args!("KB_NODE_CMD: {e}"));
            return ExitCode::FAILURE;
        }
    };
    let listener = match TcpListener::bind((host.as_str(), port)).await {
        Ok(l) => l,
        Err(e) => {
            logger::error("http", format_args!("listen {host}:{port}: {e}"));
            return ExitCode::FAILURE;
        }
    };
    logger::info("http", format_args!("listening on http://{host}:{port}"));
    // only a child we started has KB_ZB_REMOTE: a Node started by hand runs its own GZM (server/http.ts boot()), so
    // here it keeps the zbiorkom cities and their routes, as in stage 1
    let owns_zb = child.is_some();
    if owns_zb {
        // server/http.ts boot(): GZM beside the BB pollers (a no-op with KB_GZM=0); other zbiorkom cities start on
        // their first request and the registry arms its own idle sweep
        gzm::start_gzm();
    }
    let (mut term, mut int) = (
        signal(SignalKind::terminate()).expect("SIGTERM"),
        signal(SignalKind::interrupt()).expect("SIGINT"),
    );
    let app = Arc::new(http::App::new(statics, node_port, owns_zb));
    let exited = tokio::select! {
        _ = accept_loop(listener, app) => None,
        _ = term.recv() => None,
        _ = int.recv() => None,
        st = async { match child.as_mut() { Some(c) => c.wait().await, None => std::future::pending().await } } => Some(st),
    };
    // the GZM fleet tracker's debounced save (TS poller-singleton flushes on SIGTERM/SIGINT); a no-op when never built
    let _ = tokio::task::spawn_blocking(gzm_fleet::flush_gzm_fleet).await;
    if let Some(st) = exited {
        // one failure domain: Docker's restart policy brings both back
        let st = st.map_or_else(|e| e.to_string(), |s| s.to_string());
        logger::error("http", format_args!("node exited ({st}), stopping"));
        return ExitCode::FAILURE;
    }
    if let Some(c) = child.as_mut()
        && let Some(pid) = c.id()
    {
        // SAFETY: kill(2) on the pid of our own child, which has not been reaped yet
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
        if tokio::time::timeout(CHILD_GRACE, c.wait()).await.is_err() {
            logger::warn("http", "node did not exit in time, killing it");
            let _ = c.kill().await;
        }
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let base_env: Vec<_> = std::env::vars_os().collect();
    load_env_files();
    match std::env::args().nth(1).as_deref() {
        Some("healthcheck") => healthcheck(),
        None | Some("serve") => tokio::runtime::Builder::new_multi_thread()
            // tokio's default is 512; compose's pids_limit (256) counts threads, Node's included
            .max_blocking_threads(32)
            .enable_all()
            .build()
            .expect("tokio runtime")
            .block_on(serve(base_env)),
        Some(other) => {
            eprintln!("unknown command {other:?}; usage: unimaps [serve | healthcheck]");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::self_origin;

    #[test]
    fn self_origin_is_ipv4_loopback_for_any_wildcard_bind() {
        assert_eq!(self_origin("0.0.0.0", 8080), "http://127.0.0.1:8080");
        assert_eq!(self_origin("::", 8080), "http://127.0.0.1:8080");
        assert_eq!(self_origin("::1", 8081), "http://[::1]:8081");
        assert_eq!(self_origin("192.0.2.4", 8080), "http://192.0.2.4:8080");
        assert_eq!(self_origin("localhost", 8080), "http://localhost:8080");
    }
}
