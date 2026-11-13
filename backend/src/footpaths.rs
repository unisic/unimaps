//! Walking distances along OSM footpaths (footways, crossings, steps, underpasses, streets with their pavements) for
//! the router's walks: the transfers between poles and the walk to / from a searched point. The graph comes from a
//! Geofabrik extract (`KB_FOOT_PBF_URL`, default the Silesian voivodeship: BB and GZM), downloaded into
//! `output/foot/` and parsed once per process; a pole the graph does not reach keeps the straight-line estimate.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use osmpbf::{Element, ElementReader};

use crate::config;
use crate::logger;

/// a long straight piece of road is cut into pieces this long, so the nearest node is never far off a point's path
const PIECE_M: f64 = 50.0;
/// a point further than this from every path is off the network
const SNAP_M: f64 = 100.0;
/// grid cell of the snapping index; snapping searches the cells next to a point's, i.e. at least SNAP_M
const CELL_M: f64 = 120.0;
/// a path is kept only this close to a transit stop of the extract: the router's longest walk, a 1600 m path between
/// points 800 m apart, stays inside an ellipse whose far edge is 800 + 400 m from the pole. Cells of half this, 2
/// around a stop.
const NEAR_M: f64 = 1_200.0;
/// a connected piece of network this small (a platform or a sidewalk drawn apart from the street) is dropped: a
/// point snapping into it would reach nothing
const MIN_ISLAND: u32 = 200;
const M_PER_DEG: f64 = 111_320.0;
/// cos 55° N: a cell's longitude span is sized there, so it is never narrower than its metres anywhere in Poland
const COS_NORTH: f64 = 0.573;
/// shortcut: the extract is fetched again only at a start past this age; a server that never restarts keeps its paths
const MAX_AGE: Duration = Duration::from_secs(30 * 86_400);
/// the Silesian extract is ~190 MB (2026-11)
const MAX_BYTES: u64 = 1 << 30;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Walkable `highway` values; `cycleway`, `trunk` and `bridleway` only with an explicit foot permission.
const WALK: &[&str] = &[
    "footway",
    "pedestrian",
    "path",
    "steps",
    "living_street",
    "residential",
    "service",
    "unclassified",
    "tertiary",
    "tertiary_link",
    "secondary",
    "secondary_link",
    "primary",
    "primary_link",
    "track",
    "corridor",
    "platform",
    "road",
];
const WITH_FOOT: &[&str] = &["cycleway", "trunk", "trunk_link", "bridleway"];

/// Whether a node with these tags is a transit stop.
fn transit_stop<'a>(mut tags: impl Iterator<Item = (&'a str, &'a str)>) -> bool {
    tags.any(|t| {
        matches!(
            t,
            ("highway", "bus_stop")
                | ("railway", "tram_stop" | "halt" | "station")
                | ("public_transport", "platform" | "stop_position")
        )
    })
}

/// Whether a way with these tags can be walked.
pub fn walkable<'a>(tags: impl Iterator<Item = (&'a str, &'a str)>) -> bool {
    let (mut highway, mut foot, mut access, mut platform) = ("", "", "", false);
    for (k, v) in tags {
        match k {
            "highway" => highway = v,
            "foot" => foot = v,
            "access" => access = v,
            "railway" | "public_transport" if v == "platform" => platform = true,
            _ => {}
        }
    }
    let foot_yes = matches!(foot, "yes" | "designated" | "permissive");
    if matches!(foot, "no" | "private" | "use_sidepath") || (matches!(access, "no" | "private") && !foot_yes) {
        return false;
    }
    WALK.contains(&highway) || platform || (foot_yes && WITH_FOOT.contains(&highway))
}

fn dist_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let d_lat = (lat2 - lat1) * M_PER_DEG;
    let d_lon = (lon2 - lon1) * M_PER_DEG * ((lat1 + lat2) / 2.0).to_radians().cos();
    (d_lat * d_lat + d_lon * d_lon).sqrt()
}

fn cell_of(lat: f64, lon: f64, m: f64) -> (i64, i64) {
    let span = m / M_PER_DEG;
    ((lat / span).floor() as i64, (lon * COS_NORTH / span).floor() as i64)
}

fn cell_key((y, x): (i64, i64)) -> u64 {
    ((y as u32 as u64) << 32) | x as u32 as u64
}

/// The walkable network: nodes numbered in grid-cell order, edges as CSR, lengths from the coordinates. ~21 B a
/// node: Silesia near its stops is ~3.6 M nodes, ~75 MB.
pub struct FootGraph {
    lat: Vec<f32>,
    lon: Vec<f32>,
    /// the neighbours of node i are adj[first[i]..first[i + 1]]
    first: Vec<u32>,
    adj: Vec<u32>,
    /// the cells holding nodes, sorted; cell i's nodes run from cell_first[i] up to cell_first[i + 1]
    cell_keys: Vec<u64>,
    cell_first: Vec<u32>,
}

impl FootGraph {
    /// The graph of the ways in `refs` (way i = refs[ends[i - 1]..ends[i]], indices into `coords`; NaN = a node
    /// missing from the extract): the pieces with an end `near` a stop, without islands under MIN_ISLAND nodes.
    /// Pieces longer than PIECE_M get extra nodes.
    pub fn build(
        mut coords: Vec<(f32, f32)>,
        refs: &[u32],
        ends: &[usize],
        near: impl Fn((f64, f64)) -> bool,
    ) -> FootGraph {
        let at = |coords: &[(f32, f32)], i: u32| {
            let (lat, lon) = coords[i as usize];
            (f64::from(lat), f64::from(lon))
        };
        // pieces add ~20% (Silesia)
        coords.reserve(coords.len() / 4);
        let mut edges: Vec<(u32, u32)> = Vec::with_capacity(refs.len());
        let mut start = 0;
        for &end in ends {
            for w in refs[start..end].windows(2) {
                let (a, b) = (w[0], w[1]);
                let ((la, oa), (lb, ob)) = (at(&coords, a), at(&coords, b));
                if a == b || la.is_nan() || lb.is_nan() || !(near((la, oa)) || near((lb, ob))) {
                    continue;
                }
                let pieces = (dist_m(la, oa, lb, ob) / PIECE_M).ceil().max(1.0) as u32;
                let mut prev = a;
                for k in 1..pieces {
                    let t = f64::from(k) / f64::from(pieces);
                    coords.push(((la + (lb - la) * t) as f32, (oa + (ob - oa) * t) as f32));
                    let mid = coords.len() as u32 - 1;
                    edges.push((prev, mid));
                    prev = mid;
                }
                edges.push((prev, b));
            }
            start = end;
        }
        {
            let mut root: Vec<u32> = (0..coords.len() as u32).collect();
            let find = |root: &mut Vec<u32>, mut i: u32| {
                while root[i as usize] != i {
                    root[i as usize] = root[root[i as usize] as usize];
                    i = root[i as usize];
                }
                i
            };
            for &(a, b) in &edges {
                let (ra, rb) = (find(&mut root, a), find(&mut root, b));
                root[ra.max(rb) as usize] = ra.min(rb);
            }
            let mut size = vec![0u32; coords.len()];
            for i in 0..coords.len() as u32 {
                size[find(&mut root, i) as usize] += 1;
            }
            edges.retain(|&(a, _)| size[find(&mut root, a) as usize] >= MIN_ISLAND);
        }
        let mut degree = vec![0u32; coords.len()];
        for &(a, b) in &edges {
            degree[a as usize] += 1;
            degree[b as usize] += 1;
        }
        let key = |i: u32| {
            let (lat, lon) = at(&coords, i);
            cell_key(cell_of(lat, lon, CELL_M))
        };
        // nodes on an edge, renumbered by cell so a cell is one run of nodes
        let mut order: Vec<u32> = (0..coords.len() as u32).filter(|&i| degree[i as usize] > 0).collect();
        order.sort_unstable_by_key(|&i| key(i));
        let mut renum = vec![u32::MAX; coords.len()];
        let (mut cell_keys, mut cell_first) = (Vec::new(), Vec::new());
        let (mut lat, mut lon, mut first) = (
            Vec::with_capacity(order.len()),
            Vec::with_capacity(order.len()),
            Vec::with_capacity(order.len() + 1),
        );
        first.push(0u32);
        for (n, &old) in order.iter().enumerate() {
            renum[old as usize] = n as u32;
            let k = key(old);
            if cell_keys.last() != Some(&k) {
                cell_keys.push(k);
                cell_first.push(n as u32);
            }
            let (la, lo) = coords[old as usize];
            lat.push(la);
            lon.push(lo);
            first.push(first[n] + degree[old as usize]);
        }
        cell_first.push(order.len() as u32);
        drop((order, degree, coords));
        cell_keys.shrink_to_fit();
        cell_first.shrink_to_fit();
        let mut fill: Vec<u32> = first[..lat.len()].to_vec();
        let mut adj = vec![0u32; edges.len() * 2];
        for (a, b) in edges {
            let (a, b) = (renum[a as usize], renum[b as usize]);
            adj[fill[a as usize] as usize] = b;
            fill[a as usize] += 1;
            adj[fill[b as usize] as usize] = a;
            fill[b as usize] += 1;
        }
        FootGraph {
            lat,
            lon,
            first,
            adj,
            cell_keys,
            cell_first,
        }
    }

    pub fn nodes(&self) -> usize {
        self.lat.len()
    }

    /// Heap bytes held.
    pub fn bytes(&self) -> usize {
        4 * (self.lat.capacity()
            + self.lon.capacity()
            + self.first.capacity()
            + self.adj.capacity()
            + self.cell_first.capacity())
            + 8 * self.cell_keys.capacity()
    }

    fn at(&self, n: u32) -> (f64, f64) {
        (f64::from(self.lat[n as usize]), f64::from(self.lon[n as usize]))
    }

    /// The node nearest to a point and its distance, None past SNAP_M.
    fn snap(&self, (lat, lon): (f64, f64)) -> Option<(u32, f64)> {
        let (y, x) = cell_of(lat, lon, CELL_M);
        let mut best: Option<(u32, f64)> = None;
        for dy in -1..=1 {
            for dx in -1..=1 {
                let Ok(c) = self.cell_keys.binary_search(&cell_key((y + dy, x + dx))) else {
                    continue;
                };
                for n in self.cell_first[c]..self.cell_first[c + 1] {
                    let (la, lo) = self.at(n);
                    let d = dist_m(lat, lon, la, lo);
                    if d <= SNAP_M && best.is_none_or(|b| d < b.1) {
                        best = Some((n, d));
                    }
                }
            }
        }
        best
    }

    /// Walking metres from `from` to each of `to` along the network, None where an end is off it or the walk would be
    /// longer than `max_m`. One Dijkstra bounded by `max_m`.
    pub fn walk_m(&self, from: (f64, f64), to: &[(f64, f64)], max_m: f64) -> Vec<Option<f64>> {
        let mut out = vec![None; to.len()];
        let Some((src, d0)) = self.snap(from) else {
            return out;
        };
        let mut wanted: HashMap<u32, Vec<(usize, f64)>> = HashMap::new();
        for (i, &p) in to.iter().enumerate() {
            if let Some((n, d)) = self.snap(p) {
                wanted.entry(n).or_default().push((i, d));
            }
        }
        let mut left = wanted.len();
        // centimetres, so the heap orders integers
        let cm = |m: f64| (m * 100.0).round() as u64;
        let max_cm = cm(max_m);
        let mut best: HashMap<u32, u64> = HashMap::from([(src, cm(d0))]);
        let mut heap = BinaryHeap::from([(Reverse(cm(d0)), src)]);
        while left > 0
            && let Some((Reverse(d), n)) = heap.pop()
        {
            if best.get(&n).is_some_and(|&b| b < d) {
                continue;
            }
            if let Some(ends) = wanted.get(&n) {
                left -= 1;
                for &(i, tail) in ends {
                    let m = d as f64 / 100.0 + tail;
                    if m <= max_m {
                        out[i] = Some(m);
                    }
                }
            }
            let (la, lo) = self.at(n);
            for &m in &self.adj[self.first[n as usize] as usize..self.first[n as usize + 1] as usize] {
                let (lb, ob) = self.at(m);
                let nd = d + cm(dist_m(la, lo, lb, ob));
                if nd <= max_cm && best.get(&m).is_none_or(|&b| nd < b) {
                    best.insert(m, nd);
                    heap.push((Reverse(nd), m));
                }
            }
        }
        out
    }
}

static GRAPH: OnceLock<FootGraph> = OnceLock::new();

/// The footpath graph once it has loaded.
pub fn graph() -> Option<&'static FootGraph> {
    GRAPH.get()
}

/// Installs the graph (the loader, or a test); false when one is already in.
pub fn install(g: FootGraph) -> bool {
    GRAPH.set(g).is_ok()
}

/// Two passes over a .osm.pbf: the walkable ways, then the coordinates of their nodes and the transit stops.
pub fn read_pbf(file: &Path) -> Result<FootGraph, String> {
    let mut refs: Vec<i64> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();
    ElementReader::from_path(file)
        .and_then(|r| {
            r.for_each(|e| {
                if let Element::Way(w) = e
                    && walkable(w.tags())
                {
                    refs.extend(w.refs());
                    ends.push(refs.len());
                }
            })
        })
        .map_err(|e| e.to_string())?;
    let mut ids = refs.clone();
    ids.sort_unstable();
    ids.dedup();
    ids.shrink_to_fit();
    // every ref is in ids
    let refs: Vec<u32> = refs.iter().map(|r| ids.binary_search(r).unwrap_or(0) as u32).collect();
    let mut coords = vec![(f32::NAN, f32::NAN); ids.len()];
    let mut stops: HashSet<(i64, i64)> = HashSet::new();
    ElementReader::from_path(file)
        .and_then(|r| {
            r.for_each(|e| {
                let (id, lat, lon, stop) = match e {
                    Element::DenseNode(n) => (n.id(), n.lat(), n.lon(), transit_stop(n.tags())),
                    Element::Node(n) => (n.id(), n.lat(), n.lon(), transit_stop(n.tags())),
                    _ => return,
                };
                if stop {
                    stops.insert(cell_of(lat, lon, NEAR_M / 2.0));
                }
                if let Ok(i) = ids.binary_search(&id) {
                    coords[i] = (lat as f32, lon as f32);
                }
            })
        })
        .map_err(|e| e.to_string())?;
    drop(ids);
    let near = |(lat, lon): (f64, f64)| {
        let (y, x) = cell_of(lat, lon, NEAR_M / 2.0);
        (-2..=2).any(|dy| (-2..=2).any(|dx| stops.contains(&(y + dy, x + dx))))
    };
    Ok(FootGraph::build(coords, &refs, &ends, near))
}

/// Streams `url` into `file` (through a temporary file of this process: a second server on the same output/ downloads
/// beside it).
async fn download(url: &str, file: &Path) -> Result<u64, String> {
    let mut res = crate::fetch::client()
        .get(url)
        .header("User-Agent", config::USER_AGENT.as_str())
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut out = std::io::BufWriter::new(std::fs::File::create(&tmp).map_err(|e| e.to_string())?);
    let mut bytes = 0u64;
    let body: Result<(), String> = async {
        while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
            bytes += chunk.len() as u64;
            if bytes > MAX_BYTES {
                return Err("extract over the size cap".into());
            }
            out.write_all(&chunk).map_err(|e| e.to_string())?;
        }
        out.flush().map_err(|e| e.to_string())
    }
    .await;
    drop(out);
    match body.and_then(|()| std::fs::rename(&tmp, file).map_err(|e| e.to_string())) {
        Ok(()) => Ok(bytes),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Loads the graph in the background: the kept extract when younger than MAX_AGE, else a fresh download (the old
/// extract when that fails), then the routers already built compute their walking transfers.
pub fn start_footpaths() {
    let Some(url) = config::FOOT_PBF_URL.as_deref() else {
        return;
    };
    let name = url
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or("extract.osm.pbf");
    let file: PathBuf = Path::new(&*config::OUTPUT_DIR).join("foot").join(name);
    let url = url.to_owned();
    tokio::spawn(async move {
        let fresh = std::fs::metadata(&file)
            .and_then(|m| m.modified())
            .is_ok_and(|t| t.elapsed().is_ok_and(|age| age < MAX_AGE));
        if !fresh {
            match download(&url, &file).await {
                Ok(bytes) => logger::info("foot", format_args!("downloaded {bytes} B of {url}")),
                Err(e) => logger::error("foot", format_args!("download failed: {e}")),
            }
        }
        if !file.exists() {
            return;
        }
        let loaded = tokio::task::spawn_blocking(move || {
            let t = Instant::now();
            // a broken extract would otherwise stay "fresh" for MAX_AGE
            let g = read_pbf(&file).inspect_err(|_| {
                let _ = std::fs::remove_file(&file);
            })?;
            let msg = format!(
                "{} nodes, {} MB in {} ms",
                g.nodes(),
                g.bytes() >> 20,
                t.elapsed().as_millis()
            );
            install(g);
            // glibc keeps what the parse freed (~140 MB measured); musl (the Docker image) returns it itself
            #[cfg(all(target_os = "linux", target_env = "gnu"))]
            // SAFETY: only hands free heap pages back to the kernel
            unsafe {
                libc::malloc_trim(0);
            }
            let t = Instant::now();
            crate::router::warm_walks();
            Ok::<String, String>(format!("{msg}, transfers in {} ms", t.elapsed().as_millis()))
        })
        .await;
        match loaded {
            Ok(Ok(msg)) => logger::info("foot", msg),
            Ok(Err(e)) => logger::error("foot", format_args!("parse failed: {e}")),
            Err(e) => logger::error("foot", e),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// metres east / north of 50.25 N 19.0 E
    fn p(east: f64, north: f64) -> (f64, f64) {
        (
            50.25 + north / M_PER_DEG,
            19.0 + east / (M_PER_DEG * 50.25f64.to_radians().cos()),
        )
    }

    fn graph(coords: &[(f64, f64)], ways: &[&[u32]], near: impl Fn((f64, f64)) -> bool) -> FootGraph {
        let coords = coords.iter().map(|&(lat, lon)| (lat as f32, lon as f32)).collect();
        let refs: Vec<u32> = ways.concat();
        let mut ends: Vec<usize> = Vec::new();
        for w in ways {
            ends.push(ends.last().unwrap_or(&0) + w.len());
        }
        FootGraph::build(coords, &refs, &ends, near)
    }

    #[test]
    fn walkable_follows_the_foot_tags() {
        let w = |tags: &[(&'static str, &'static str)]| walkable(tags.iter().copied());
        assert!(w(&[("highway", "footway"), ("tunnel", "yes")]));
        assert!(w(&[("highway", "residential")]));
        assert!(w(&[("railway", "platform")]));
        assert!(!w(&[("highway", "motorway")]));
        assert!(!w(&[("highway", "trunk")]));
        assert!(w(&[("highway", "cycleway"), ("foot", "designated")]));
        assert!(!w(&[("highway", "primary"), ("foot", "no")]));
        assert!(!w(&[("highway", "service"), ("access", "private")]));
        assert!(w(&[("highway", "service"), ("access", "private"), ("foot", "yes")]));
        assert!(!w(&[("building", "yes")]));
    }

    /// A block: the two poles stand 100 m apart across it, the path goes round three of its sides (300 m); a 10 km
    /// street leads off it, so it is no island.
    fn block() -> FootGraph {
        let coords = [
            p(0.0, 0.0),
            p(0.0, 100.0),
            p(100.0, 100.0),
            p(100.0, 0.0),
            p(400.0, 0.0),
            p(10_400.0, 0.0),
        ];
        let g = graph(&coords, &[&[0, 1, 2, 3], &[3, 4, 5]], |_| true);
        assert!(g.nodes() > MIN_ISLAND as usize);
        g
    }

    #[test]
    fn walks_round_the_block_not_across_it() {
        let g = block();
        let m = g.walk_m(p(0.0, -5.0), &[p(100.0, -5.0), p(250.0, 3.0)], 700.0);
        assert!((m[0].unwrap() - 310.0).abs() < 1.0, "{m:?}");
        // a point mid-way along the long piece snaps to an added node, not to an end 150 m away
        assert!((m[1].unwrap() - (5.0 + 300.0 + 150.0 + 3.0)).abs() < 20.0, "{m:?}");
    }

    #[test]
    fn off_the_network_or_past_the_bound_is_none() {
        let g = block();
        assert_eq!(g.walk_m(p(0.0, -5.0), &[p(100.0, -500.0)], 700.0), vec![None]);
        assert_eq!(g.walk_m(p(0.0, -500.0), &[p(100.0, -5.0)], 700.0), vec![None]);
        assert_eq!(g.walk_m(p(0.0, -5.0), &[p(100.0, -5.0)], 200.0), vec![None]);
    }

    #[test]
    fn missing_nodes_lone_points_islands_and_far_paths_add_nothing() {
        let mut coords = [p(0.0, 0.0), p(50.0, 0.0), (f64::NAN, f64::NAN), p(500.0, 500.0)];
        let ways: &[&[u32]] = &[&[0, 1, 2], &[3]];
        assert_eq!(graph(&coords, ways, |_| true).nodes(), 0, "a 50 m path is an island");
        coords[1] = p(20_000.0, 0.0);
        let g = graph(&coords, ways, |_| true);
        assert!(g.nodes() >= MIN_ISLAND as usize);
        assert_eq!(g.walk_m(p(0.0, 0.0), &[p(500.0, 500.0)], 700.0), vec![None]);
        let g = graph(&coords, ways, |(lat, _)| lat > 51.0);
        assert_eq!(g.nodes(), 0, "no end near a stop");
    }

    #[test]
    fn transit_stops_are_bus_and_tram_stops() {
        assert!(transit_stop([("name", "Rynek"), ("highway", "bus_stop")].into_iter()));
        assert!(transit_stop([("railway", "tram_stop")].into_iter()));
        assert!(!transit_stop([("highway", "crossing")].into_iter()));
    }
}
