<script module lang="ts">
  /** Only reveal stops once zoomed in to street level: not the whole time. */
  const ZOOM_THRESHOLD = 14;
  /** Render a margin beyond the viewport so a small pan doesn't pop-in markers. */
  const BOUNDS_PAD = 0.25;
</script>

<script lang="ts">
  import L from "leaflet";

  import { CITY, getPageCity } from "@/lib/client/city";
  import { displayStopName, isBusStation } from "@/lib/client/format";
  import { makeStopIcon } from "@/lib/client/leafletIcons";
  import type { Stop } from "@/lib/client/types";

  /**
   * Bus-stop markers with GTFS-derived direction arrows. Shown only at
   * ZOOM_THRESHOLD+ and culled to the padded viewport, so at most a few dozen
   * lightweight divIcons exist at once (the ~950-stop set never all mounts).
   * Markers are diffed in/out on move so panning never re-pops the whole set.
   */
  let {
    map,
    stops,
    visible,
    onSelect,
    minZoom = ZOOM_THRESHOLD,
  }: {
    map: L.Map;
    stops: Stop[];
    visible: boolean;
    onSelect: (stop: Stop) => void;
    /** zoom from which stops are drawn (default ZOOM_THRESHOLD; GZM's ~7400 stops start a level later) */
    minZoom?: number;
  } = $props();

  $effect(() => {
    const list = stops;
    const on = visible;
    const min = minZoom;
    const group = L.layerGroup().addTo(map);
    const shown = new Map<string, L.Marker>();
    const iconCache = new Map<string, L.DivIcon>();

    const iconFor = (s: Stop): L.DivIcon => {
      const isStation = isBusStation(s.name, s);
      const dirs = isStation ? [] : (s.dirs ?? []);
      const op = s.operator ?? "KB";
      const key = `${isStation ? "stn" : "stop"}-${op}-${dirs.length ? dirs.join(",") : "-"}`;
      let ic = iconCache.get(key);
      if (!ic) {
        ic = makeStopIcon(dirs, isStation, op);
        iconCache.set(key, ic);
      }
      return ic;
    };

    const render = (): void => {
      const desired = new Set<string>();
      if (on && list.length && map.getZoom() >= min) {
        const b = map.getBounds().pad(BOUNDS_PAD);
        for (const s of list) {
          if (b.contains([s.lat, s.lon])) desired.add(s.id);
        }
      }
      // drop markers that scrolled out of view (or that a zoom-out hid entirely)
      for (const [id, m] of shown) {
        if (!desired.has(id)) {
          group.removeLayer(m);
          shown.delete(id);
        }
      }
      // add newly-visible stops, keeping the ones already on the map untouched
      if (desired.size) {
        for (const s of list) {
          if (!desired.has(s.id) || shown.has(s.id)) continue;
          const m = L.marker([s.lat, s.lon], {
            icon: iconFor(s),
            keyboard: false,
            zIndexOffset: -50, // below the live vehicle pills
          });
          const label = document.createElement("span");
          const opBadge =
            s.operator === "BOTH"
              ? " · KB + MZK"
              : s.operator === "MZK"
                ? " · MZK"
                : s.operator === "GZM"
                  ? ` · ${CITY[getPageCity()].name}`
                  : " · KB";
          label.textContent = `${displayStopName(s.name)}${s.symbol ? ` (${s.symbol})` : ""}${opBadge}`;
          m.bindTooltip(label, { direction: "top", offset: [0, -14], opacity: 1, className: "kb-tooltip" });
          m.on("click", () => onSelect(s));
          m.addTo(group);
          shown.set(s.id, m);
        }
      }
    };

    render();
    map.on("moveend", render);
    map.on("zoomend", render);
    return () => {
      map.off("moveend", render);
      map.off("zoomend", render);
      group.remove();
    };
  });
</script>
