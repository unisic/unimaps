<script module lang="ts">
  import type { ConnectionLeg } from "@/lib/client/types";

  const TAB = "tap inline-flex h-9 shrink-0 items-center gap-2 rounded-full text-[13px] font-medium";
  const tabTone = (on: boolean) =>
    on ? "bg-primary-dim text-primary" : "bg-tint/6 text-text-mute hover:bg-tint/10 hover:text-text";

  /** a timeline row; the columns (time, rail, text) line up with TripView's */
  const ROW = "flex w-full items-stretch gap-3 rounded-xl text-left transition-colors enabled:hover:bg-tint/5 enabled:active:bg-tint/8";
  const TIME = "w-12 shrink-0 self-center pl-1 text-right tabular-nums";

  /** one half of the rail: a ride in its line colour, the dotted walk, the wait at one stop, or nothing */
  type Seg = { color: string } | "walk" | "wait" | null;
  /** a stop on the rail (big = where you board or alight) */
  type RailNode = { color: string; big: boolean };
  type RailArgs = { top: Seg; bottom: Seg; node?: RailNode };

  /** the walk's dots; the map draws the same ones with a dashArray */
  const WALK_DOTS =
    "background-image: radial-gradient(circle, var(--color-text-mute) 1.5px, transparent 2px); background-size: 6px 7px; background-repeat: repeat-y; background-position: center top";

  /** what joins leg `i` to the one before it */
  const joinOf = (legs: ConnectionLeg[], i: number): Seg =>
    i <= 0 || i >= legs.length ? null : (legs[i].walkMins ?? 0) > 0 ? "walk" : "wait";
</script>

<script lang="ts">
  import { untrack, type Snippet } from "svelte";

  import BottomSheet from "@/components/BottomSheet.svelte";
  import Icon from "@/components/Icon.svelte";
  import {
    ArrowsLeftRightIcon,
    BellIcon,
    CaretDownIcon,
    CaretLeftIcon,
    PersonSimpleWalkIcon,
    XIcon,
  } from "@/components/icon-paths";
  import IconButton from "@/components/ui/IconButton.svelte";
  import LineBadge from "@/components/ui/LineBadge.svelte";
  import { notify } from "@/lib/client/alerts";
  import { displayStopName, przystanekPlural } from "@/lib/client/format";
  import type { ConnectionLegStop, JourneyView as JourneyViewState, Vehicle } from "@/lib/client/types";
  import { alightSoon, indexVehicles, legVehicle, transferAtRisk } from "@/lib/client/vehicleIndex";

  let {
    journey,
    desktop,
    onClose,
    onBackToSearch,
    onSelectLeg,
    onFocusStop,
    vehicles,
    onShowToast,
  }: {
    journey: JourneyViewState;
    desktop: boolean;
    onClose: () => void;
    onBackToSearch: () => void;
    onSelectLeg: (legIdx: number | null) => void;
    onFocusStop: (lat: number, lon: number) => void;
    /** the live fleet: the alight alarm follows each leg's bus */
    vehicles: readonly Vehicle[];
    onShowToast: (msg: string) => void;
  } = $props();

  let expandedLegs = $state<Record<number, boolean>>({});
  /* "Budzik": a nudge one stop before each alighting, while this sheet is open. ponytail: page JS only
     (iOS suspends it in the background); server push of the same check if riders need it pocketed */
  let alarm = $state(false);
  const fired = new Set<number>();
  const vix = $derived(alarm ? indexVehicles(vehicles) : null);
  $effect(() => {
    const ix = vix;
    if (!ix) return;
    const { legs, date } = journey.itinerary;
    const gen = journey.gen;
    // notify and the toast write state elsewhere: a read in there must not re-run this check
    untrack(() => {
      const buses = legs.map((l) => legVehicle(l, date, ix));
      const risk = transferAtRisk(legs, buses.map((v) => v?.delay ?? null));
      buses.forEach((v, i) => {
        if (!v || fired.has(i) || !alightSoon(legs[i], date, v)) return;
        fired.add(i);
        const next = legs[i + 1];
        const title = `Wysiadasz na następnym: ${displayStopName(legs[i].toStopName)}`;
        const body = next
          ? `Przesiadka na linię ${next.line} o ${next.departureTime}${risk ? ". Opóźnienie: możesz nie zdążyć" : ""}`
          : `Linia ${legs[i].line}, koniec podróży`;
        void notify(title, body, `alight:${gen}:${i}`, "/");
        navigator.vibrate?.([300, 150, 300]);
        onShowToast(title);
      });
    });
  });
  async function toggleAlarm() {
    if (alarm) {
      alarm = false;
      return;
    }
    // asked from the tap: browsers drop a permission prompt without a user gesture
    if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
    alarm = true;
    onShowToast("Powiadomię przystanek przed wysiadaniem. Działa, gdy aplikacja jest otwarta.");
  }

  const itinerary = $derived(journey.itinerary);
  const legs = $derived(itinerary.legs);
  const fromTitle = $derived(legs[0]?.fromStopName || "Początek");
  const toTitle = $derived(legs[legs.length - 1]?.toStopName || "Koniec");
  const selectedLegIdx = $derived(journey.selectedLegIdx);
  const dimmed = (...legIdx: number[]) =>
    selectedLegIdx !== null && !legIdx.includes(selectedLegIdx) ? "opacity-50" : "";

  const facts = $derived.by(() => {
    const n = itinerary.transfersCount;
    return [
      `${itinerary.totalDurationMins} min`,
      n ? `${n} ${n === 1 ? "przesiadka" : "przesiadki"}` : "bez przesiadek",
      itinerary.walkMinutes ? `${itinerary.walkMinutes} min pieszo` : "",
      itinerary.dayLabel ?? "",
    ].filter(Boolean);
  });
</script>

{#snippet half(seg: Seg, bottom: boolean)}
  {#if seg}
    {@const at = `absolute left-1/2 h-1/2 -translate-x-1/2 ${bottom ? "bottom-0" : "top-0"}`}
    {#if seg === "walk"}
      <span class="w-1.5 {at}" style={WALK_DOTS}></span>
    {:else if seg === "wait"}
      <span class="w-0.5 bg-tint/12 {at}"></span>
    {:else}
      <span class="w-1.5 {at}" style:background={seg.color}></span>
    {/if}
  {/if}
{/snippet}

<!-- the rail column; `node` is a stop on it -->
{#snippet rail(top: Seg, bottom: Seg, node: RailNode | undefined, inner: Snippet | undefined)}
  <span class="relative w-6 shrink-0 self-stretch" aria-hidden="true">
    {@render half(top, false)}
    {@render half(bottom, true)}
    {#if node}
      <span
        class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full {node.big
          ? 'h-2.5 w-2.5'
          : 'h-1.5 w-1.5'}"
        style:background="var(--color-surface)"
        style:box-shadow={`0 0 0 ${node.big ? 3 : 2}px ${node.color}`}
      ></span>
    {/if}
    {@render inner?.()}
  </span>
{/snippet}

{#snippet stopRow(st: ConnectionLegStop | undefined, name: string, time: string, r: RailArgs, major: boolean)}
  <button
    type="button"
    disabled={!st?.lat || !st.lon}
    onclick={() => st?.lat && st.lon && onFocusStop(st.lat, st.lon)}
    class={ROW}
  >
    <span class="{TIME} {major ? 'text-[13px] font-semibold text-text' : 'text-[12px] text-text-faint'}">{time}</span>
    {@render rail(r.top, r.bottom, r.node, undefined)}
    <span
      class="min-w-0 flex-1 self-center truncate pr-2 {major
        ? 'py-3 text-[13.5px] font-medium text-text'
        : 'py-2 text-[12.5px] text-text-mute'}"
    >
      {displayStopName(name)}
    </span>
  </button>
{/snippet}

<BottomSheet {desktop} {onClose} ariaLabel={`Trasa połączenia ${fromTitle} do ${toTitle}`} initialSnap="half">
  {#snippet header()}
    <header class="px-4 pb-3 pt-2 md:pt-4">
      <div class="flex items-center gap-2">
        <IconButton onClick={onBackToSearch} label="Wróć do wyników wyszukiwania">
          <Icon icon={CaretLeftIcon} />
        </IconButton>
        <div class="min-w-0 flex-1 pl-0.5">
          <h2 class="truncate text-[16px] font-semibold leading-tight tracking-tight text-text">
            {displayStopName(fromTitle)} → {displayStopName(toTitle)}
          </h2>
          <!-- a line break falls between facts, never inside "5 min pieszo" -->
          <p class="mt-1 text-[12px] leading-snug text-text-mute">
            <span class="whitespace-nowrap font-semibold tabular-nums text-text">
              {itinerary.departureTime} – {itinerary.arrivalTime}
            </span>{#if itinerary.arrivesNextDay}<span class="font-medium text-late" title="Przyjazd następnego dnia"
                >{" "}+1 d.</span
              >{/if}{#each facts as f (f)}{"\u00a0· "}<span class="whitespace-nowrap tabular-nums">{f}</span>{/each}
          </p>
        </div>
        <IconButton onClick={() => void toggleAlarm()} label="Budzik: powiadom przed wysiadaniem" pressed={alarm}>
          <Icon icon={BellIcon} weight={alarm ? "fill" : "bold"} />
        </IconButton>
        <IconButton onClick={onClose} label="Zamknij widok trasy">
          <Icon icon={XIcon} />
        </IconButton>
      </div>

      {#if legs.length > 1}
        <div class="-mx-4 mt-3 flex items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]">
          <button
            type="button"
            onclick={() => onSelectLeg(null)}
            aria-pressed={selectedLegIdx === null}
            class="{TAB} px-3.5 {tabTone(selectedLegIdx === null)}"
          >
            Cała trasa
          </button>
          {#each legs as leg, lIdx (lIdx)}
            <button
              type="button"
              onclick={() => onSelectLeg(lIdx)}
              aria-pressed={selectedLegIdx === lIdx}
              aria-label={`Odcinek ${lIdx + 1}: linia ${leg.line}, ${leg.durationMins} min`}
              class="{TAB} pl-1 pr-3 {tabTone(selectedLegIdx === lIdx)}"
            >
              <LineBadge line={leg.line} operator={leg.operator} />
              <span class="tabular-nums">{leg.durationMins} min</span>
            </button>
          {/each}
        </div>
      {/if}
    </header>
  {/snippet}

  <div class="kb-scroll h-full overflow-y-auto">
    <ol class="px-4 pt-1" style:padding-bottom="calc(env(safe-area-inset-bottom, 0px) + 1.25rem)">
      {#each legs as leg, lIdx (lIdx)}
        {@const ride = { color: journey.legs[lIdx].lineColor }}
        {@const node = { color: ride.color, big: true }}
        {@const join = joinOf(legs, lIdx)}
        {@const stops = leg.stops ?? []}
        {@const mids = stops.slice(1, -1)}
        {@const open = !!expandedLegs[lIdx]}
        {@const fade = `transition-opacity duration-200 ${dimmed(lIdx)}`}
        {@const walk = leg.walkMins ?? 0}
        {@const prev = legs[lIdx - 1]}
        {@const gap = prev ? Math.max(1, Math.round((leg.departureSecs - prev.arrivalSecs) / 60)) : 0}

        <!-- transfer: the walk on dots, a wait at one stop on a thin line -->
        {#if prev}
          {#snippet bubble()}
            <span
              class="absolute left-1/2 top-1/2 grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-surface-2 text-[13px] {walk
                ? 'text-text'
                : 'text-late'}"
            >
              <Icon icon={walk ? PersonSimpleWalkIcon : ArrowsLeftRightIcon} />
            </span>
          {/snippet}
          <li class="transition-opacity duration-200 {dimmed(lIdx - 1, lIdx)}">
            <div class="flex items-stretch gap-3">
              <span class="w-12 shrink-0"></span>
              {@render rail(join, join, undefined, bubble)}
              <span class="min-w-0 flex-1 self-center py-3.5 text-[12px] text-text-mute">
                <span class="block text-[13px] font-medium text-text">
                  {walk ? `${walk} min pieszo` : `Przesiadka ${gap} min`}
                </span>
                <span class="block tabular-nums">{walk ? `Przesiadka ${gap} min` : "Ten sam przystanek"}</span>
              </span>
            </div>
          </li>
        {/if}

        <li class={fade}>
          {@render stopRow(stops[0], leg.fromStopName, leg.departureTime, { top: join, bottom: ride, node }, true)}
        </li>

        <li class={fade}>
          <button
            type="button"
            disabled={!mids.length}
            onclick={() => (expandedLegs[lIdx] = !expandedLegs[lIdx])}
            aria-expanded={mids.length ? open : undefined}
            class={ROW}
          >
            <span class="w-12 shrink-0"></span>
            {@render rail(ride, ride, undefined, undefined)}
            <span class="min-w-0 flex-1 self-center py-2.5 pr-2">
              <span class="flex min-w-0 items-center gap-2">
                <LineBadge line={leg.line} operator={leg.operator} />
                <span class="truncate text-[13px] font-medium text-text">{displayStopName(leg.headsign)}</span>
              </span>
              <span class="mt-1 flex items-center gap-1 text-[12px] text-text-mute">
                <span class="tabular-nums">{leg.durationMins} min</span>
                {#if mids.length > 0}
                  <span>
                    · {mids.length} {przystanekPlural(mids.length)} po drodze
                  </span>
                  <Icon
                    icon={CaretDownIcon}
                    class={`text-[12px] text-text-faint transition-transform duration-200 ${open ? "rotate-180" : ""}`}
                  />
                {/if}
              </span>
            </span>
          </button>
        </li>

        {#if open}
          {#each mids as st, sIdx (`${sIdx}-${st.stopId}`)}
            <li class="{fade} animate-fade">
              {@render stopRow(
                st,
                st.stopName,
                st.arrivalTime || st.departureTime,
                { top: ride, bottom: ride, node: { color: ride.color, big: false } },
                false,
              )}
            </li>
          {/each}
        {/if}

        <li class={fade}>
          {@render stopRow(
            stops[stops.length - 1],
            leg.toStopName,
            leg.arrivalTime,
            { top: ride, bottom: joinOf(legs, lIdx + 1), node },
            true,
          )}
        </li>
      {/each}
    </ol>
  </div>
</BottomSheet>
