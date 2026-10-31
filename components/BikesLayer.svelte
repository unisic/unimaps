<script module lang="ts">
  import type { BikeStation } from "@/lib/client/types";

  /** street level, like stops: the ~950 stations never all mount */
  const MIN_ZOOM = 14;
  const BOUNDS_PAD = 0.25;
  /** the GBFS feed's ttl */
  const REFRESH_MS = 60_000;

  const plural = (n: number): string =>
    n === 1 ? "rower" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "rowery" : "rowerów";
  const tip = (s: BikeStation): string =>
    `Metrorower ${s.name} · ${s.bikes} ${plural(s.bikes)}${s.url ? " · kliknij, aby wypożyczyć" : ""}`;
</script>

<script lang="ts">
  import L from "leaflet";

  import { fetchJSON } from "@/lib/client/api";
  import { cityUrl, getPageCity } from "@/lib/client/city";
  import { makeBikeIcon } from "@/lib/client/leafletIcons";
  import type { BikesResponse } from "@/lib/client/types";

  /**
   * Metrorower stations (GZM bike share) with the live bike count. Fetched every 60 s only while
   * visible, zoomed in and the tab is shown; culled to the padded viewport and diffed like
   * StopsLayer. A changed count is written into the existing marker (setIcon rewrites the DOM).
   */
  let { map, visible }: { map: L.Map; visible: boolean } = $props();

  const city = getPageCity();

  $effect(() => {
    if (!visible) return;
    const group = L.layerGroup().addTo(map);
    const shown = new Map<string, { m: L.Marker; bikes: number }>();
    const icons = new Map<number, L.DivIcon>();
    let stations: BikeStation[] = [];
    let fetchedAt = 0;
    let ctl: AbortController | null = null;

    const iconFor = (n: number): L.DivIcon => {
      let ic = icons.get(n);
      if (!ic) {
        ic = makeBikeIcon(n);
        icons.set(n, ic);
      }
      return ic;
    };

    const render = (): void => {
      const desired = new Set<string>();
      if (stations.length && map.getZoom() >= MIN_ZOOM) {
        const b = map.getBounds().pad(BOUNDS_PAD);
        for (const s of stations) if (b.contains([s.lat, s.lon])) desired.add(s.id);
      }
      for (const [id, e] of shown) {
        if (!desired.has(id)) {
          group.removeLayer(e.m);
          shown.delete(id);
        }
      }
      if (!desired.size) return;
      for (const s of stations) {
        if (!desired.has(s.id)) continue;
        const cur = shown.get(s.id);
        if (cur) {
          if (cur.bikes === s.bikes) continue;
          cur.bikes = s.bikes;
          cur.m.setTooltipContent(tip(s));
          const el = cur.m.getElement()?.querySelector<HTMLElement>(".bike-mk");
          const n = el?.querySelector(".bike-mk-n");
          if (el && n) {
            el.classList.toggle("is-empty", s.bikes === 0);
            n.textContent = String(s.bikes);
          } else cur.m.setIcon(iconFor(s.bikes));
          continue;
        }
        const m = L.marker([s.lat, s.lon], { icon: iconFor(s.bikes), keyboard: false, zIndexOffset: -60 });
        m.bindTooltip(tip(s), { direction: "top", offset: [0, -10], opacity: 1, className: "kb-tooltip" });
        const url = s.url;
        if (url) m.on("click", () => window.open(url, "_blank", "noopener"));
        m.addTo(group);
        shown.set(s.id, { m, bikes: s.bikes });
      }
    };

    const load = async (): Promise<void> => {
      if (ctl || document.hidden || map.getZoom() < MIN_ZOOM || Date.now() - fetchedAt < REFRESH_MS) return;
      const ac = new AbortController();
      ctl = ac;
      try {
        const r = await fetchJSON<BikesResponse>(cityUrl("/api/bikes", city), { cache: "no-cache", signal: ac.signal });
        if (ac.signal.aborted) return;
        fetchedAt = Date.now();
        if (Array.isArray(r.stations)) {
          stations = r.stations;
          render();
        }
      } catch {
        /* keep the last list; the next tick retries */
      } finally {
        if (ctl === ac) ctl = null;
      }
    };

    const onZoom = (): void => {
      render();
      void load();
    };
    const tick = (): void => void load();
    render();
    void load();
    map.on("moveend", render);
    map.on("zoomend", onZoom);
    document.addEventListener("visibilitychange", tick);
    const timer = setInterval(tick, 15_000);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      map.off("moveend", render);
      map.off("zoomend", onZoom);
      ctl?.abort();
      group.remove();
    };
  });
</script>
