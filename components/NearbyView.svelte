<script lang="ts">
  import { untrack } from "svelte";

  import BottomSheet from "@/components/BottomSheet.svelte";
  import type { GeoStatus } from "@/components/hooks.svelte";
  import Icon from "@/components/Icon.svelte";
  import { CaretRightIcon, MapPinIcon, PersonSimpleWalkIcon, XIcon } from "@/components/icon-paths";
  import ErrorState from "@/components/ui/ErrorState.svelte";
  import IconButton from "@/components/ui/IconButton.svelte";
  import LineBadge from "@/components/ui/LineBadge.svelte";
  import LiveMark from "@/components/ui/LiveMark.svelte";
  import SkeletonRows from "@/components/ui/SkeletonRows.svelte";
  import { fetchJSON, isWarming } from "@/lib/client/api";
  import { cityOfId, GZM_LOADING } from "@/lib/client/city";
  import { delayClass, displayStopName } from "@/lib/client/format";
  import { formatDistance, formatWalk, nearestStops } from "@/lib/client/geo";
  import { createLivePoll } from "@/lib/client/live-poll";
  import type { DepartureRow, DeparturesResponse, Stop, Vehicle } from "@/lib/client/types";
  import { indexVehicles, rowVehicle } from "@/lib/client/vehicleIndex";
  import { etaLabel, resolveTiming, sortBoard, uniqueKeys } from "@/lib/shared/departures";

  /** The few stops closest to the user with their next departures, one tap from the full stop sheet.
   *  Mounted only while open, like StopView. */
  let {
    desktop,
    stops,
    pos,
    geoStatus,
    place,
    vehicles,
    onSelectStop,
    onClose,
  }: {
    desktop: boolean;
    stops: Stop[];
    /** null until the first fix (opened from the palette before locating) */
    pos: { lat: number; lon: number } | null;
    geoStatus: GeoStatus;
    /** an address from search instead of the user's position: `pos` is its point */
    place?: { name: string; detail: string } | null;
    vehicles?: Vehicle[];
    onSelectStop: (s: Stop) => void;
    onClose: () => void;
  } = $props();

  const NEAR_STOPS = 3;
  const ROWS_PER_STOP = 3;

  /** designator -> its live rows, or null when that one board failed */
  type Boards = Map<string, DepartureRow[] | null>;

  const near = $derived(pos ? nearestStops(stops, pos, NEAR_STOPS) : []);
  /* the poll restarts only when the SET of nearby stops changes, not on every GPS fix */
  const key = $derived(
    near
      .map((n) => n.s.designator)
      .sort()
      .join("\n"),
  );
  let boards = $state.raw<Boards | null>(null);
  /* "warming": the server is still loading the GZM data (503); the poll keeps retrying */
  let err = $state<false | "error" | "warming">(false);
  let attempt = $state(0);
  let nowTs = $state(Date.now() / 1000);

  $effect(() => {
    const k = key;
    void attempt;
    if (!k) return;
    return untrack(() => {
      const designators = k.split("\n");
      let skew = 0;
      let have = false;
      const poll = createLivePoll<Boards>({
        load: async (signal) => {
          const res = await Promise.allSettled(
            designators.map((d) =>
              fetchJSON<DeparturesResponse>(`/api/stop/${encodeURIComponent(d)}/departures`, { cache: "no-store", signal }),
            ),
          );
          const out: Boards = new Map();
          res.forEach((r, i) => {
            out.set(designators[i], r.status === "fulfilled" ? (r.value.rows ?? []) : null);
            if (r.status === "fulfilled" && typeof r.value.server_ts === "number") {
              skew = r.value.server_ts - Date.now() / 1000;
            }
          });
          // every leg failed: a poll failure (backoff), not three "brak danych"
          if (res.every((r) => r.status === "rejected")) throw (res[0] as PromiseRejectedResult).reason;
          return out;
        },
        onOk: (b) => {
          have = true;
          boards = b;
          err = false;
          nowTs = Date.now() / 1000 + skew;
        },
        onFail: (e) => {
          if (!have) err = cityOfId(designators[0]) !== "bb" && isWarming(e) ? "warming" : "error";
        },
        isVisible: () => !document.hidden,
      });
      poll.start();
      const kick = () => poll.kick();
      document.addEventListener("visibilitychange", kick);
      const id = setInterval(() => {
        nowTs = Date.now() / 1000 + skew;
        poll.tick();
      }, 5000);
      return () => {
        poll.stop();
        clearInterval(id);
        document.removeEventListener("visibilitychange", kick);
      };
    });
  });

  const vix = $derived(indexVehicles(vehicles));

  function itemsOf(s: Stop) {
    const rows = boards?.get(s.designator);
    const items =
      rows == null
        ? []
        : sortBoard(
            rows.map((row) => ({ row, timing: resolveTiming(row, rowVehicle(row, vix)) })),
            nowTs,
          ).slice(0, ROWS_PER_STOP);
    return { rows, items, keys: uniqueKeys(items.map((it) => it.row)) };
  }
</script>

<BottomSheet {desktop} {onClose} ariaLabel="Odjazdy w pobliżu">
  {#snippet header()}
    <header class="px-4 pb-3 pt-2 md:pt-4">
      <div class="flex items-center gap-3">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-tint/6 text-[18px] text-text-mute">
          <Icon icon={place ? MapPinIcon : PersonSimpleWalkIcon} />
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-[17px] font-semibold leading-tight tracking-tight text-text">
            {place ? place.name : "W pobliżu"}
          </h2>
          <p class="mt-0.5 truncate text-[12px] text-text-faint">
            {place?.detail ? `${place.detail} · najbliższe przystanki` : "Najbliższe przystanki i odjazdy"}
          </p>
        </div>
        <IconButton label="Zamknij" onClick={onClose}>
          <Icon icon={XIcon} />
        </IconButton>
      </div>
    </header>
  {/snippet}

  <div
    class="kb-scroll h-full overflow-y-auto pb-4 animate-fade"
    style:padding-bottom="calc(env(safe-area-inset-bottom, 0px) + 1.25rem)"
  >
    {#if !pos}
      <p class="px-6 py-10 text-center text-[13.5px] text-text-faint">
        {geoStatus === "locating"
          ? "Ustalam lokalizację…"
          : geoStatus === "idle"
            ? "Lokalizacja wyłączona."
            : "Brak dostępu do lokalizacji. Włącz ją w ustawieniach przeglądarki."}
      </p>
    {:else if near.length === 0}
      <SkeletonRows />
    {:else if err && !boards}
      <ErrorState
        message={err === "warming" ? GZM_LOADING : undefined}
        onRetry={() => {
          err = false;
          attempt += 1;
        }}
      />
    {:else}
      {#each near as { s, dist } (s.id)}
        {@const { rows, items, keys } = itemsOf(s)}
        <section class="px-2 pt-2">
          <button
            type="button"
            onclick={() => onSelectStop(s)}
            class="tap flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-tint/5 active:bg-tint/8"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate text-[14.5px] font-semibold text-text">
                {displayStopName(s.name)}{#if s.symbol}<span class="ml-1.5 font-normal text-text-faint">{s.symbol}</span>{/if}
              </p>
              <p class="mt-0.5 text-[12px] tabular-nums text-text-faint">
                {formatDistance(dist)}, {formatWalk(dist)}
              </p>
            </div>
            <Icon icon={CaretRightIcon} class="shrink-0 text-text-faint" />
          </button>
          {#if rows === undefined}
            <SkeletonRows />
          {:else if rows === null}
            <p class="px-2 pb-2 text-[12.5px] text-text-faint">Brak danych z tego przystanku</p>
          {:else if items.length === 0}
            <p class="px-2 pb-2 text-[12.5px] text-text-faint">Brak odjazdów w najbliższym czasie</p>
          {:else}
            <ul>
              {#each items as { row, timing }, i (keys[i])}
                {@const line = row.line_name || row.symbol || "?"}
                {@const dest = row.direction || rowVehicle(row, vix)?.headsign}
                {@const est = timing.estimated && !timing.canceled}
                <li>
                  <button
                    type="button"
                    onclick={() => onSelectStop(s)}
                    class="tap flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-tint/5 active:bg-tint/8"
                  >
                    <LineBadge {line} operator={row.operator} />
                    <p class="min-w-0 flex-1 truncate text-[13.5px] text-text">
                      {dest ? displayStopName(dest) : `Linia ${line}`}
                    </p>
                    <p
                      class="flex shrink-0 items-center gap-1 text-[14px] font-semibold tabular-nums {timing.canceled
                        ? 'text-text-faint line-through'
                        : est
                          ? delayClass(timing.delaySec)
                          : 'text-text'}"
                    >
                      {#if est}<LiveMark />{/if}{etaLabel(timing, nowTs, row.time ?? "")}
                    </p>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</BottomSheet>
