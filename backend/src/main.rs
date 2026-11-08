//! The Unimaps server. `unimaps` (or `unimaps serve`) listens on HOST:PORT, serves the static build (KB_STATIC_DIR,
//! default <cwd>/out), boots the BB pollers, GZM and the push ticks (server/http.ts boot()) and answers every API
//! request. `unimaps healthcheck` exits 0 when /api/health answers 2xx (Docker / compose healthcheck).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::Semaphore;
use unimaps::{config, fetch, gtfs_builder, gzm, http, logger, poller_singleton, push_alerts, push_news, static_files};

/// ponytail: one cap for every open connection (idle keep-alive ones included, ~8 KB of buffers each).
const MAX_CONNECTIONS: usize = 1024;
/// an idle keep-alive connection, or one still sending its headers, is closed after this (Node: 5 s idle, 60 s for
/// headers); it bounds how long one client holds a MAX_CONNECTIONS slot without sending anything
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
/// how long the pollers get to stop and flush their stores after SIGTERM
const STOP_GRACE: Duration = Duration::from_secs(5);
/// server/http.ts listen(): `setTimeout(() => process.exit(0), 100)` after SIGTERM/SIGINT
const EXIT_GRACE: Duration = Duration::from_millis(100);

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
/// Mode: NODE_ENV when set (`npm run dev` sets "development"), else "production" for a release build
/// (as the old bundle, which inlined NODE_ENV) and "development" for a debug one.
fn load_env_files() {
    let mode = match var("NODE_ENV").as_deref() {
        Some("production") => "production",
        Some(_) => "development",
        None if cfg!(debug_assertions) => "development",
        None => "production",
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

async fn serve() -> ExitCode {
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
    let (host, port) = (var("HOST").unwrap_or_else(|| "0.0.0.0".into()), port_var("PORT", 8080));
    let listener = match TcpListener::bind((host.as_str(), port)).await {
        Ok(l) => l,
        Err(e) => {
            logger::error("http", format_args!("listen {host}:{port}: {e}"));
            return ExitCode::FAILURE;
        }
    };
    logger::info("http", format_args!("listening on http://{host}:{port}"));
    boot();
    let (mut term, mut int) = (
        signal(SignalKind::terminate()).expect("SIGTERM"),
        signal(SignalKind::interrupt()).expect("SIGINT"),
    );
    let sig = tokio::select! {
        _ = accept_loop(listener, Arc::new(http::App::owned(statics))) => "SIGTERM",
        _ = term.recv() => "SIGTERM",
        _ = int.recv() => "SIGINT",
    };
    // lib/poller-singleton.ts's signal handler: shape store, fleet trackers and GZM fleet flushed, pollers stopped.
    // ponytail: the TS exits 100 ms after the signal without awaiting the stop; here the stop gets up to STOP_GRACE
    // (5 s), past which the process exits 0 anyway (run_to_exit: blocking work gets EXIT_GRACE)
    if tokio::time::timeout(STOP_GRACE, poller_singleton::bb().shutdown(sig))
        .await
        .is_err()
    {
        logger::warn("rt", "pollers did not stop in time");
    }
    ExitCode::SUCCESS
}

/// server/http.ts boot(): the BB pollers, GZM beside them (its failure never touches BB) and, with
/// push on, the push stores, so alerts persisted before a restart fire without waiting for a request.
fn boot() {
    // the call loads the shape store before accept_loop runs, as startPoller() inside boot() does in the TS
    let start = poller_singleton::bb().start_poller();
    tokio::spawn(async move {
        if let Err(err) = start.await {
            logger::error(
                "rt",
                format_args!("background poller start failed: {}", fetch::string_err(err)),
            );
        }
    });
    gzm::start_gzm();
    if *config::PUSH_ENABLED {
        push_alerts::get_push_alerts();
        push_news::get_push_news();
    }
}

/// The options of scripts/build-gtfs.ts, parsed like node:util `parseArgs` in strict mode (its codes and
/// messages; any error exits 1 as the uncaught TypeError does).
struct GtfsArgs {
    date: Option<String>,
    out: Option<String>,
    concurrency: Option<String>,
    no_zip: bool,
    single_day: bool,
}

fn parse_gtfs_args(args: &[String]) -> Result<GtfsArgs, String> {
    let invalid = |m: String| format!("TypeError [ERR_PARSE_ARGS_INVALID_OPTION_VALUE]: {m}");
    let unknown = |o: &str| format!("TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option '{o}'");
    let positional = |a: &str| {
        format!(
            "TypeError [ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL]: Unexpected argument '{a}'. This command does not take \
             positional arguments"
        )
    };
    let mut out = GtfsArgs {
        date: None,
        out: None,
        concurrency: None,
        no_zip: false,
        single_day: false,
    };
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if arg == "--" {
            return match it.next() {
                Some(p) => Err(positional(p)),
                None => Ok(out),
            };
        }
        let Some(body) = arg.strip_prefix("--") else {
            let mut c = arg.chars();
            return Err(match (c.next(), c.next()) {
                (Some('-'), Some(o)) => unknown(&format!("-{o}")),
                _ => positional(arg),
            });
        };
        let (name, inline) = match body.find('=') {
            Some(k) if k > 0 => (&body[..k], Some(&body[k + 1..])),
            _ => (body, None),
        };
        let slot = match name {
            "date" => &mut out.date,
            "out" => &mut out.out,
            "concurrency" => &mut out.concurrency,
            "zip" | "no-zip" | "single-day" => {
                if inline.is_some() {
                    return Err(invalid(format!("Option '--{name}' does not take an argument")));
                }
                match name {
                    "no-zip" => out.no_zip = true,
                    "single-day" => out.single_day = true,
                    _ => {}
                }
                continue;
            }
            _ => return Err(unknown(&format!("--{name}"))),
        };
        let value = match inline {
            Some(v) => v,
            None => {
                let Some(v) = it.next() else {
                    return Err(invalid(format!("Option '--{name} <value>' argument missing")));
                };
                if v.starts_with('-') && v.chars().nth(1).is_some() {
                    return Err(invalid(format!(
                        "Option '--{name}' argument is ambiguous.\nDid you forget to specify the option argument \
                         for '--{name}'?\nTo specify an option argument starting with a dash use '--{name}=-XYZ'."
                    )));
                }
                v
            }
        };
        *slot = Some(value.to_owned());
    }
    Ok(out)
}

/// scripts/build-gtfs.ts: `unimaps build-gtfs [--date YYYY-MM-DD] [--out DIR] [--concurrency N] [--no-zip]
/// [--single-day]`; 0 when the feed was published, 1 on any error.
fn build_gtfs_cli(args: &[String]) -> ExitCode {
    let a = match parse_gtfs_args(args) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let n = a
        .concurrency
        .map_or(*config::DEFAULT_CONCURRENCY as f64, |c| unimaps::js::number(&c));
    let concurrency = if n.is_finite() && n > 0.0 {
        n.trunc()
    } else {
        *config::DEFAULT_CONCURRENCY as f64
    };
    let fatal = |e: String| {
        logger::error("gtfs", format_args!("fatal: {e}"));
        ExitCode::FAILURE
    };
    // pLimit(0) throws: `--concurrency 0.5` fails as in the TS
    if concurrency < 1.0 {
        return fatal("TypeError: Expected `concurrency` to be a number from 1 and up".into());
    }
    let opts = gtfs_builder::BuildGtfsOptions {
        date: a.date.unwrap_or_else(|| unimaps::time::today_local().to_string()),
        out_dir: PathBuf::from(a.out.unwrap_or_else(|| config::GTFS_DIR.clone())),
        zip: !a.no_zip,
        full_schedule: !a.single_day,
    };
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return fatal(e.to_string()),
    };
    let api = unimaps::kb_api::KbApi::new(gzm::HttpZb).with_concurrency(concurrency as usize);
    match rt.block_on(gtfs_builder::build_gtfs(&api, &opts)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => fatal(format!("Error: {e}")),
    }
}

/// server/http.ts exits 100 ms after the signal whatever is still running; a plain runtime drop would wait for
/// every spawn_blocking task (a GZM zip parse, fleet-history day reads) to finish.
fn run_to_exit(rt: tokio::runtime::Runtime, serve: impl Future<Output = ExitCode>) -> ExitCode {
    let code = rt.block_on(serve);
    rt.shutdown_timeout(EXIT_GRACE);
    code
}

fn main() -> ExitCode {
    // glibc gives every tokio thread its own arena and keeps what they free: measured 1.3 GB RSS and growing
    // after 7 min of BB + GZM + Warsaw, 510 MB flat with 2 arenas. musl (the Docker image) has no arenas.
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: called before any other thread exists
    unsafe {
        libc::mallopt(libc::M_ARENA_MAX, 2);
    }
    let args: Vec<String> = std::env::args_os().map(|a| a.to_string_lossy().into_owned()).collect();
    // `tsx scripts/build-gtfs.ts` reads no .env file, the server entries do
    if args.get(1).map(String::as_str) == Some("build-gtfs") {
        return build_gtfs_cli(args.get(2..).unwrap_or_default());
    }
    load_env_files();
    match args.get(1).map(String::as_str) {
        Some("healthcheck") => healthcheck(),
        None | Some("serve") => run_to_exit(
            tokio::runtime::Builder::new_multi_thread()
                // tokio's default is 512; compose's pids_limit (256) counts threads
                .max_blocking_threads(32)
                .enable_all()
                .build()
                .expect("tokio runtime"),
            serve(),
        ),
        Some(other) => {
            eprintln!("unknown command {other:?}; usage: unimaps [serve | healthcheck | build-gtfs]");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{boot, parse_gtfs_args, run_to_exit};
    use std::process::ExitCode;
    use std::time::{Duration, Instant};

    /// server/main.ts runs boot() in the tick of listen(): startPoller() loads the shape store synchronously, so no
    /// request callback ever sees it unloaded. boot() returns before accept_loop runs: the store must be loaded then.
    #[test]
    fn boot_loads_the_shape_store_before_the_first_accept() {
        let dir = std::env::temp_dir().join(format!("unimaps-main-boot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("shapes")).unwrap();
        let entry = r#"{"src":"osrm","poly":"_p~iF~ps|U_ulLnnqC","len":1234.5,"stops":[0,1234.5],"rev":"7b21c0"}"#;
        let file = format!(r#"{{"format":"kb-map/route-shapes","version":1,"shapes":{{"kb:3f9a0c11d2e4":{entry}}}}}"#);
        std::fs::write(dir.join("shapes/route-shapes.v1.json"), file).unwrap();
        // SAFETY: the only test of this binary that reads the configuration, set before its first read
        unsafe {
            std::env::set_var("KB_OUTPUT_DIR", &dir);
            for k in [
                "KB_BASE_URL",
                "KB_ZB_API_URL",
                "HTTPS_PROXY",
                "https_proxy",
                "HTTP_PROXY",
                "http_proxy",
            ] {
                std::env::set_var(k, "http://127.0.0.1:9");
            }
            for k in ["KB_OSRM_URL", "KB_GEOCODER_URL", "KB_GZM_NEWS_URL"] {
                std::env::set_var(k, "off");
            }
            for k in ["KB_GZM", "KB_ZB", "KB_PUSH"] {
                std::env::set_var(k, "0");
            }
            std::env::set_var("KB_LOG_LEVEL", "error");
        }
        // current_thread: nothing boot() spawns runs before the assertion, and blocking_io runs inline
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            boot();
            let shapes = unimaps::poller_singleton::bb().shapes();
            assert_eq!(
                shapes.wire_id("kb:3f9a0c11d2e4").as_deref(),
                Some("kb:3f9a0c11d2e4.7b21c0")
            );
        });
    }

    #[test]
    fn exit_does_not_wait_for_running_blocking_work() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let started = Instant::now();
        let code = run_to_exit(rt, async {
            drop(tokio::task::spawn_blocking(|| {
                std::thread::sleep(Duration::from_secs(8))
            }));
            tokio::time::sleep(Duration::from_millis(50)).await;
            ExitCode::SUCCESS
        });
        assert_eq!(code, ExitCode::SUCCESS);
        assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
    }

    fn parse(args: &[&str]) -> Result<(Option<String>, bool, bool), String> {
        let v: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        parse_gtfs_args(&v).map(|a| (a.date, a.no_zip, a.single_day))
    }

    #[test]
    fn gtfs_args_follow_node_parse_args_strict() {
        let err = |a: &[&str]| parse(a).err().unwrap_or_default();
        assert_eq!(
            err(&["--foo=bar"]),
            "TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option '--foo'"
        );
        assert_eq!(
            err(&["--=x"]),
            "TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option '--=x'"
        );
        assert_eq!(
            err(&["-zx"]),
            "TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option '-z'"
        );
        assert!(err(&["-"]).starts_with("TypeError [ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL]: Unexpected argument '-'."));
        assert!(err(&["--", "x"]).contains("Unexpected argument 'x'."));
        assert!(err(&["--date", "--"]).contains("Option '--date' argument is ambiguous.\nDid you forget"));
        assert_eq!(parse(&["--"]), Ok((None, false, false)));
        assert_eq!(parse(&["--date", "-"]), Ok((Some("-".into()), false, false)));
        assert_eq!(
            parse(&["--date=a", "--date", "b", "--no-zip", "--single-day", "--zip"]),
            Ok((Some("b".into()), true, true))
        );
    }
}
