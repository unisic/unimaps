//! lib/micro-cache.ts: a tiny TTL cache with in-flight coalescing for hot public per-key data (the stop departures
//! board). N viewers of one stop cost one upstream call per `ttl`, and a burst of simultaneous requests shares one
//! load. A failed load is never cached (every joiner sees it, the next caller retries), `cacheable` can refuse a
//! value (a partial board), and at most `max` values are kept, the oldest inserted evicted first. The TS `ageMs`
//! has no reader and is not ported. Hold a cheap-to-clone `T` (an `Arc`): every hit clones it.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use indexmap::IndexMap;
use tokio::sync::OnceCell;
use tokio::time::Instant;

type Slot<T, E> = Arc<OnceCell<Result<T, E>>>;

struct State<T, E> {
    done: IndexMap<String, (T, Instant)>,
    inflight: HashMap<String, Slot<T, E>>,
}

pub struct MicroCache<T, E> {
    ttl: Duration,
    max: usize,
    cacheable: fn(&T) -> bool,
    state: Mutex<State<T, E>>,
}

impl<T, E> MicroCache<T, E> {
    pub fn new(ttl: Duration, max: usize, cacheable: fn(&T) -> bool) -> Self {
        Self {
            ttl,
            max,
            cacheable,
            state: Mutex::new(State {
                done: IndexMap::new(),
                inflight: HashMap::new(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State<T, E>> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Cached values (not loads in flight).
    pub fn len(&self) -> usize {
        self.lock().done.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Drops the cached values; a load in flight still settles for its joiners and is then cached.
    pub fn clear(&self) {
        self.lock().done.clear();
    }
}

impl<T: Clone, E: Clone> MicroCache<T, E> {
    /// The fresh value of `key`, else the result of the load already in flight for it, else of `load`. A caller
    /// dropped while it runs `load` hands the load to the next joiner (the JS promise ran on regardless).
    pub async fn get<F, Fut>(&self, key: &str, load: F) -> Result<T, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        let slot = {
            let mut s = self.lock();
            if let Some((v, at)) = s.done.get(key) {
                if at.elapsed() < self.ttl {
                    return Ok(v.clone());
                }
                s.done.shift_remove(key);
            }
            s.inflight.entry(key.to_owned()).or_default().clone()
        };
        let join = Join { cache: self, key, slot };
        let res = join.slot.get_or_init(load).await.clone();
        let mut s = self.lock();
        if s.inflight.get(key).is_some_and(|c| Arc::ptr_eq(c, &join.slot)) {
            s.inflight.remove(key);
            if let Ok(v) = &res
                && (self.cacheable)(v)
            {
                s.done.insert(key.to_owned(), (v.clone(), Instant::now()));
                while s.done.len() > self.max {
                    s.done.shift_remove_index(0);
                }
            }
        }
        res
    }
}

/// Removes the slot of a load whose callers were all dropped before it finished, so a cancelled request leaves
/// nothing in `inflight`.
struct Join<'a, T, E> {
    cache: &'a MicroCache<T, E>,
    key: &'a str,
    slot: Slot<T, E>,
}

impl<T, E> Drop for Join<'_, T, E> {
    fn drop(&mut self) {
        if self.slot.initialized() {
            return;
        }
        let mut s = self.cache.lock();
        // under the lock every waiting caller holds a clone: two references = the map's and this one
        if Arc::strong_count(&self.slot) == 2 && s.inflight.get(self.key).is_some_and(|c| Arc::ptr_eq(c, &self.slot)) {
            s.inflight.remove(self.key);
        }
    }
}

/// Port of test/micro-cache.test.ts.
#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};

    use tokio::sync::Notify;
    use tokio::time::advance;

    use super::*;

    const TTL: Duration = Duration::from_millis(4000);

    #[tokio::test]
    async fn coalesces_concurrent_loads_into_one_upstream_call() {
        let c = MicroCache::<&str, ()>::new(TTL, 500, |_| true);
        let (calls, gate) = (&AtomicUsize::new(0), &Notify::new());
        let load = move || async move {
            calls.fetch_add(1, SeqCst);
            gate.notified().await;
            Ok("rows")
        };
        let out = tokio::join!(c.get("a", load), c.get("a", load), c.get("a", load), async {
            tokio::task::yield_now().await;
            gate.notify_one();
        });
        assert_eq!((out.0, out.1, out.2), (Ok("rows"), Ok("rows"), Ok("rows")));
        assert_eq!(calls.load(SeqCst), 1);
        assert!(c.lock().inflight.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn serves_from_cache_inside_the_ttl_and_reloads_after_it() {
        let c = MicroCache::<usize, ()>::new(TTL, 500, |_| true);
        let n = &AtomicUsize::new(0);
        let load = move || async move { Ok(n.fetch_add(1, SeqCst) + 1) };
        assert_eq!(c.get("k", load).await, Ok(1));
        advance(Duration::from_millis(3999)).await;
        assert_eq!(c.get("k", load).await, Ok(1));
        advance(Duration::from_millis(1)).await;
        assert_eq!(c.get("k", load).await, Ok(2));
        assert_eq!(n.load(SeqCst), 2);
    }

    #[tokio::test]
    async fn never_caches_a_failure_joiners_all_see_it_the_next_caller_retries() {
        let c = MicroCache::<&str, &str>::new(TTL, 500, |_| true);
        let gate = &Notify::new();
        let load = move || async move {
            gate.notified().await;
            Err("upstream down")
        };
        let (a, b, ()) = tokio::join!(c.get("k", load), c.get("k", load), async {
            tokio::task::yield_now().await;
            gate.notify_one();
        });
        assert_eq!((a, b), (Err("upstream down"), Err("upstream down")));
        assert!(c.is_empty());
        assert_eq!(c.get("k", || async { Ok("ok") }).await, Ok("ok"));
    }

    #[tokio::test]
    async fn cacheable_can_refuse_a_partial_result() {
        let c = MicroCache::<bool, ()>::new(TTL, 500, |partial| !partial);
        let n = &AtomicUsize::new(0);
        let load = move || async move { Ok(n.fetch_add(1, SeqCst) == 0) };
        c.get("k", load).await.unwrap();
        c.get("k", load).await.unwrap();
        assert_eq!(n.load(SeqCst), 2, "the first (partial) was not cached");
        c.get("k", load).await.unwrap();
        assert_eq!(n.load(SeqCst), 2, "the second (complete) was cached");
    }

    #[tokio::test]
    async fn is_bounded_oldest_inserted_keys_go_first() {
        let c = MicroCache::<u8, ()>::new(Duration::from_secs(1_000_000), 2, |_| true);
        for k in ["a", "b", "c"] {
            c.get(k, || async { Ok(1) }).await.unwrap();
        }
        assert_eq!(c.len(), 2);
        let reloaded = AtomicUsize::new(0);
        c.get("a", || async {
            reloaded.fetch_add(1, SeqCst);
            Ok(1)
        })
        .await
        .unwrap();
        assert_eq!(reloaded.load(SeqCst), 1);
    }

    #[tokio::test]
    async fn a_dropped_caller_hands_the_load_on_and_leaves_nothing_behind() {
        let c = MicroCache::<&str, ()>::new(TTL, 500, |_| true);
        let gate = &Notify::new();
        let stuck = move || async move {
            gate.notified().await;
            Ok("never")
        };
        // the runner is dropped mid-load while a joiner waits: the joiner runs its own load and caches it
        let mut runner = Box::pin(c.get("k", stuck));
        assert!(poll_once(runner.as_mut()).await.is_none());
        let mut joiner = Box::pin(c.get("k", || async { Ok("joiner") }));
        assert!(poll_once(joiner.as_mut()).await.is_none());
        drop(runner);
        assert_eq!(joiner.await, Ok("joiner"));
        assert!(c.lock().inflight.is_empty());
        assert_eq!(c.len(), 1);
        // a runner dropped with nobody waiting removes its slot
        let mut alone = Box::pin(c.get("x", stuck));
        assert!(poll_once(alone.as_mut()).await.is_none());
        assert_eq!(c.lock().inflight.len(), 1);
        drop(alone);
        assert!(c.lock().inflight.is_empty());
    }

    #[tokio::test]
    async fn a_late_joiner_never_clears_the_next_load() {
        let c = MicroCache::<&str, &str>::new(TTL, 500, |_| true);
        let (gate, calls) = (&Notify::new(), &AtomicUsize::new(0));
        let mut a = Box::pin(c.get("k", move || async move {
            gate.notified().await;
            Err("down")
        }));
        assert!(poll_once(a.as_mut()).await.is_none());
        let mut b = Box::pin(c.get("k", || async { Ok("unused") }));
        assert!(poll_once(b.as_mut()).await.is_none());
        gate.notify_one();
        assert_eq!(a.await, Err("down"));
        // a retry starts the next load before the failed one's joiner wakes up
        let next = move || async move {
            calls.fetch_add(1, SeqCst);
            gate.notified().await;
            Ok("rows")
        };
        let mut retry = Box::pin(c.get("k", next));
        assert!(poll_once(retry.as_mut()).await.is_none());
        assert_eq!(b.await, Err("down"));
        let mut join = Box::pin(c.get("k", next));
        assert!(poll_once(join.as_mut()).await.is_none());
        assert_eq!(calls.load(SeqCst), 1, "joined the running retry");
        gate.notify_one();
        assert_eq!((retry.await, join.await), (Ok("rows"), Ok("rows")));
        assert_eq!(c.len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn an_expired_key_reloads_as_the_newest() {
        let c = MicroCache::<u8, ()>::new(TTL, 3, |_| true);
        for k in ["a", "b", "c"] {
            c.get(k, || async { Ok(1) }).await.unwrap();
            advance(Duration::from_millis(1000)).await;
        }
        advance(Duration::from_millis(1000)).await;
        // a expired: it reloads at the end, b stays the oldest and goes first
        c.get("a", || async { Ok(2) }).await.unwrap();
        c.get("d", || async { Ok(1) }).await.unwrap();
        assert_eq!(c.get("c", || async { Ok(9) }).await, Ok(1));
        assert_eq!(c.get("b", || async { Ok(9) }).await, Ok(9));
    }

    async fn poll_once<F: Future + Unpin>(f: F) -> Option<F::Output> {
        tokio::select! {
            biased;
            out = f => Some(out),
            () = async {} => None,
        }
    }
}
