//! lib/gzm-match.ts: road-matched GZM shapes. zbiorkom's shapes.txt is sparse (line 27: 411 points over 38 km,
//! segments up to 670 m), so a route drawn on it cuts corners through buildings. A bus or trolleybus shape is
//! map-matched through OSRM /match when a trip of it is opened, newest open first, one geometry at a time on the shared
//! OSRM pace, persisted by the raw polyline's hash (shapes with the same geometry share one match: GZM has 4161 bus
//! and trolleybus shapes but 2642 geometries) and applied by every later feed build. Trams stay raw: the car profile
//! has no rails.
//!
//! The part of the route on screen goes first: chunks inside the focus box (the opened vehicle, then the viewer's map
//! from [`Matcher::focus`]) are matched before the rest and published at once as a `partial` shape, so the road appears
//! where the rider looks after a request or two instead of the whole ~20 s. Every request goes to the route opened or
//! watched last: a newer open waits one request, not for the whole older match, which resumes where it stopped.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use crate::config;
use crate::gzm_feed::{GzmShapes, raw_key};
use crate::js;
use crate::logger::{info, warn};
use crate::osrm::{
    ChunkMatch, Failure, HttpOsrm, MATCH_CHUNK, MATCH_CHUNK_PUBLIC, OSRM_PACE, OsrmFailure, OsrmPace, OsrmTransport,
    chunk_waypoints, match_chunk, merge_chunk_geometries, osrm_match_base, pace_request,
};
use crate::shared::polyline::{LatLng, LatLonBox, decode_polyline, encode_polyline, simplify_polyline};

const FORMAT: &str = "unimaps/gzm-matched-shapes";
/// Douglas-Peucker before matching: line 27 goes 411 -> 167 points (19 requests), each within 10 m of the raw shape.
const SIMPLIFY_M: f64 = 10.0;
/// Geometries waiting for a match; the oldest is dropped for a new one (its next open asks again).
const QUEUE_MAX: usize = 20;
const WRITE_DELAY: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct Target {
    shapes: Arc<GzmShapes>,
    rev: String,
    refs: Vec<Option<LatLng>>,
}

struct Job {
    /// tells a job from a later one of the same geometry
    id: u64,
    raw: String,
    /// every opened shape with this geometry, by shape key
    targets: IndexMap<String, Target>,
    /// what the rider sees: chunks crossing it are matched first
    focus: Option<LatLonBox>,
    /// the simplified trace in requests of the OSRM chunk size, their boxes and their matches so far
    chunks: Vec<Vec<LatLng>>,
    boxes: Vec<LatLonBox>,
    parts: Vec<Option<Vec<LatLng>>>,
    t0: Instant,
    kept: usize,
    /// ms to the first partial publish, 0 = none
    first_ms: u128,
}

impl Job {
    fn in_view(&self, i: usize) -> bool {
        self.parts[i].is_none() && self.focus.is_some_and(|f| overlaps(&self.boxes[i], &f))
    }

    fn merged(&self) -> Vec<LatLng> {
        let parts: Vec<Vec<LatLng>> = self
            .parts
            .iter()
            .zip(&self.chunks)
            .map(|(p, c)| p.as_ref().unwrap_or(c).clone())
            .collect();
        merge_chunk_geometries(&parts)
    }

    fn keys(&self) -> String {
        self.targets.keys().map(String::as_str).collect::<Vec<_>>().join(" ")
    }
}

#[derive(Default)]
struct State {
    /// rawKey -> matched polyline, read from the file on first use
    store: Option<IndexMap<String, String>>,
    /// the route opened or watched last first; at most QUEUE_MAX
    queue: Vec<Job>,
    next_id: u64,
    running: bool,
    paused_until: Option<Instant>,
    write_pending: bool,
}

impl State {
    fn store(&mut self, file: &Path) -> &mut IndexMap<String, String> {
        self.store.get_or_insert_with(|| load(file))
    }
}

/// The match queue and the stored matches of one OSRM server; [`MATCHER`] is the process's.
pub struct Matcher<T> {
    /// the /match base; None = matching off
    base: Option<String>,
    chunk: usize,
    min_interval_ms: i64,
    pace: &'static OsrmPace,
    file: PathBuf,
    transport: T,
    state: Mutex<State>,
}

/// The configured server (`KB_OSRM_URL`), on the process-wide pace, stored in `<KB_GZM_DIR>/matched-shapes.v1.json`.
pub static MATCHER: LazyLock<Arc<Matcher<HttpOsrm>>> = LazyLock::new(|| {
    Matcher::new(
        config::OSRM_URL.as_deref().and_then(osrm_match_base),
        if *config::PUBLIC_OSRM {
            MATCH_CHUNK_PUBLIC
        } else {
            MATCH_CHUNK
        },
        *config::OSRM_MIN_INTERVAL_MS,
        &OSRM_PACE,
        Path::new(config::GZM_DIR.as_str()).join("matched-shapes.v1.json"),
        HttpOsrm,
    )
});

fn load(file: &Path) -> IndexMap<String, String> {
    let read = std::fs::read_to_string(file).map_err(|e| (e.kind() == ErrorKind::NotFound, e.to_string()));
    let parsed = read.and_then(|s| crate::js::json_parse(&s).map_err(|e| (false, e.to_string())));
    match parsed {
        Ok(j) => match (j.get("format"), j.get("shapes").and_then(Value::as_object)) {
            (Some(f), Some(shapes)) if f == FORMAT => shapes
                .iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
                .collect(),
            _ => IndexMap::new(),
        },
        Err((missing, e)) => {
            if !missing {
                warn(
                    "gzm-match",
                    format!("unreadable {}, starting empty: {e}", file.display()),
                );
            }
            IndexMap::new()
        }
    }
}

#[derive(Serialize)]
struct FileBody<'a> {
    format: &'a str,
    shapes: &'a IndexMap<String, String>,
}

fn write_file(file: &Path, body: &str) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, file)
}

fn box_of(pts: &[LatLng]) -> LatLonBox {
    let mut b = LatLonBox {
        s: f64::INFINITY,
        w: f64::INFINITY,
        n: f64::NEG_INFINITY,
        e: f64::NEG_INFINITY,
    };
    for &[lat, lon] in pts {
        b.s = b.s.min(lat);
        b.n = b.n.max(lat);
        b.w = b.w.min(lon);
        b.e = b.e.max(lon);
    }
    b
}

fn overlaps(a: &LatLonBox, b: &LatLonBox) -> bool {
    a.s <= b.n && a.n >= b.s && a.w <= b.e && a.e >= b.w
}

fn to_front(queue: &mut [Job], i: usize) {
    queue[..=i].rotate_right(1);
}

impl<T: OsrmTransport + Send + Sync + 'static> Matcher<T> {
    pub fn new(
        base: Option<String>,
        chunk: usize,
        min_interval_ms: i64,
        pace: &'static OsrmPace,
        file: PathBuf,
        transport: T,
    ) -> Arc<Self> {
        Arc::new(Self {
            base,
            chunk,
            min_interval_ms,
            pace,
            file,
            transport,
            state: Mutex::new(State::default()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The stored road match (an encoded polyline) of the zbiorkom polyline with rawKey `raw`.
    pub fn stored(&self, raw: &str) -> Option<String> {
        self.lock().store(&self.file).get(raw).cloned()
    }

    // ponytail: last writer wins when two processes share output/ (a match the other one made is redone on its next open)
    fn schedule_write(self: &Arc<Self>, st: &mut State) {
        if st.write_pending {
            return;
        }
        st.write_pending = true;
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(WRITE_DELAY).await;
            let body = {
                let mut st = me.lock();
                st.write_pending = false;
                let shapes = st.store(&me.file);
                serde_json::to_string(&FileBody { format: FORMAT, shapes }).unwrap_or_default()
            };
            let file = me.file.clone();
            let done = tokio::task::spawn_blocking(move || write_file(&file, &body)).await;
            if let Err(e) = done
                .map_err(|e| e.to_string())
                .and_then(|r| r.map_err(|e| e.to_string()))
            {
                warn("gzm-match", format!("write failed: {e}"));
            }
        });
    }

    /// Forget the matches of geometries the feed in use no longer has: the file stays the feed's size.
    pub fn prune(self: &Arc<Self>, shapes: &GzmShapes) {
        let keep = shapes.raw_keys();
        let mut st = self.lock();
        let s = st.store(&self.file);
        let n = s.len();
        s.retain(|k, _| keep.contains(k));
        if s.len() != n {
            self.schedule_write(&mut st);
        }
    }

    /// Match shape `key` of `shapes` (its stops at `refs`) in the background, the part in `focus` first; a stored match
    /// applies at once. True while a match of it is queued or running. Must run inside the tokio runtime.
    pub fn request(
        self: &Arc<Self>,
        shapes: &Arc<GzmShapes>,
        key: &str,
        refs: &[Option<LatLng>],
        focus: Option<LatLonBox>,
    ) -> bool {
        let Some(e) = shapes.unmatched(key) else {
            return false;
        };
        if self.base.is_none() {
            return false;
        }
        let raw = raw_key(&e.poly);
        let mut st = self.lock();
        if let Some(m) = st.store(&self.file).get(&raw).cloned() {
            drop(st);
            shapes.upgrade(key, &e.rev, &decode_polyline(&m, 6), refs, false);
            return false;
        }
        let target = Target {
            shapes: shapes.clone(),
            rev: e.rev,
            refs: refs.to_vec(),
        };
        if let Some(i) = st.queue.iter().position(|j| j.raw == raw) {
            let job = &mut st.queue[i];
            job.targets.insert(key.to_owned(), target);
            // the viewer's map (focus) wins over the vehicle box a trip refresh brings again
            job.focus = job.focus.or(focus);
            to_front(&mut st.queue, i);
            return true;
        }
        if st.paused_until.is_some_and(|t| Instant::now() < t) {
            return false;
        }
        if st.queue.len() >= QUEUE_MAX {
            st.queue.pop();
        }
        let chunks = chunk_waypoints(&simplify_polyline(&decode_polyline(&e.poly, 6), SIMPLIFY_M), self.chunk);
        let id = st.next_id;
        st.next_id += 1;
        st.queue.insert(
            0,
            Job {
                id,
                raw,
                targets: IndexMap::from([(key.to_owned(), target)]),
                focus,
                boxes: chunks.iter().map(|c| box_of(c)).collect(),
                parts: vec![None; chunks.len()],
                chunks,
                t0: Instant::now(),
                kept: 0,
                first_ms: 0,
            },
        );
        if !st.running {
            st.running = true;
            tokio::spawn(self.clone().work());
        }
        true
    }

    /// Move the match of shape `key` to what the rider now sees and make it next; never starts one.
    pub fn focus(&self, shapes: &GzmShapes, key: &str, focus: LatLonBox) {
        let Some(e) = shapes.unmatched(key) else {
            return;
        };
        let raw = raw_key(&e.poly);
        let mut st = self.lock();
        if let Some(i) = st.queue.iter().position(|j| j.raw == raw) {
            st.queue[i].focus = Some(focus);
            to_front(&mut st.queue, i);
        }
    }

    async fn work(self: Arc<Self>) {
        let Some(base) = self.base.clone() else {
            self.lock().running = false;
            return;
        };
        loop {
            {
                let mut st = self.lock();
                if st.queue.is_empty() {
                    st.running = false;
                    return;
                }
            }
            // the slot is booked before the job is picked: a route opened or watched meanwhile goes next
            pace_request(self.pace, self.min_interval_ms).await;
            let Some((id, i, focused, chunk)) = self.pick() else {
                continue;
            };
            let r = match_chunk(&base, &chunk, &self.transport).await;
            self.settle(id, i, focused, r);
        }
    }

    /// The next request: the first job's chunk in its focus, else its first unmatched one. A job whose shapes are all
    /// matched or replaced meanwhile is dropped (None).
    fn pick(&self) -> Option<(u64, usize, bool, Vec<LatLng>)> {
        let mut st = self.lock();
        let job = st.queue.first()?;
        let live = job
            .targets
            .iter()
            .any(|(k, t)| t.shapes.unmatched(k).is_some_and(|e| e.rev == t.rev));
        let in_view = (0..job.parts.len()).find(|&j| job.in_view(j));
        match in_view.or_else(|| job.parts.iter().position(Option::is_none)) {
            Some(i) if live => Some((job.id, i, in_view.is_some(), job.chunks[i].clone())),
            _ => {
                st.queue.remove(0);
                None
            }
        }
    }

    // ponytail: a job dropped while its request runs (20 newer opens in one second) loses that request; its next open asks again
    fn settle(self: &Arc<Self>, id: u64, i: usize, focused: bool, r: Result<ChunkMatch, Failure>) {
        let mut st = self.lock();
        let at = st.queue.iter().position(|j| j.id == id);
        let m = match r {
            Ok(m) => m,
            Err(f) => {
                let ms = match f.kind {
                    OsrmFailure::Ratelimited => f.retry_after_sec.unwrap_or(60.0) * 1000.0,
                    OsrmFailure::Unavailable => 300_000.0,
                    _ => 3_600_000.0,
                };
                st.paused_until = Some(Instant::now() + Duration::from_secs_f64(ms / 1000.0));
                let keys = at.map(|q| st.queue[q].keys()).unwrap_or_default();
                st.queue.clear();
                drop(st);
                let min = js::round(ms / 60_000.0);
                warn(
                    "gzm-match",
                    format!("{keys}: {} ({}), paused {min} min", f.kind.as_str(), f.detail),
                );
                return;
            }
        };
        let Some(q) = at else { return };
        let job = &mut st.queue[q];
        job.parts[i] = Some(m.pts);
        job.kept += usize::from(m.kept);
        if job.parts.iter().any(Option::is_none) {
            // the view is matched and the rest is not: show it now, the raw rest stays off screen until the full match
            if focused && !(0..job.parts.len()).any(|j| job.in_view(j)) {
                let pts = job.merged();
                if job.first_ms == 0 {
                    job.first_ms = job.t0.elapsed().as_millis();
                }
                let targets: Vec<(String, Target)> = job.targets.iter().map(|(k, t)| (k.clone(), t.clone())).collect();
                drop(st);
                for (k, t) in targets {
                    t.shapes.upgrade(&k, &t.rev, &pts, &t.refs, true);
                }
            }
            return;
        }
        let job = st.queue.remove(q);
        let pts = job.merged();
        st.store(&self.file).insert(job.raw.clone(), encode_polyline(&pts, 6));
        self.schedule_write(&mut st);
        drop(st);
        for (k, t) in &job.targets {
            t.shapes.upgrade(k, &t.rev, &pts, &t.refs, false);
        }
        let view = if job.first_ms == 0 {
            "-".to_owned()
        } else {
            job.first_ms.to_string()
        };
        info(
            "gzm-match",
            format!(
                "{}: {} requests, {} kept raw, view in {view} ms, all in {} ms",
                job.keys(),
                job.chunks.len(),
                job.kept,
                job.t0.elapsed().as_millis()
            ),
        );
    }
}
