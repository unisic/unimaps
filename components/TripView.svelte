<script lang="ts">
  import { untrack } from "svelte";

  import BottomSheet from "@/components/BottomSheet.svelte";
  import { useNow } from "@/components/hooks.svelte";
  import Icon from "@/components/Icon.svelte";
  import {
    ArrowRightIcon,
    ArrowsClockwiseIcon,
    ArrowsHorizontalIcon,
    BellIcon,
    CardsIcon,
    CaretLeftIcon,
    CrosshairIcon,
    DotsThreeVerticalIcon,
    DropIcon,
    FlagIcon,
    LeafIcon,
    LightningIcon,
    SnowflakeIcon,
    TicketIcon,
    WheelchairIcon,
    XIcon,
    type IconDef,
  } from "@/components/icon-paths";
  import ErrorState from "@/components/ui/ErrorState.svelte";
  import IconButton from "@/components/ui/IconButton.svelte";
  import LineBadge from "@/components/ui/LineBadge.svelte";
  import ModeIcon from "@/components/ui/ModeIcon.svelte";
  import RequestStopTag from "@/components/ui/RequestStopTag.svelte";
  import ShareButton from "@/components/ui/ShareButton.svelte";
  import {
    ALERT_LEADS,
    MAX_ALERTS,
    addAlert,
    alertUntil,
    alerts,
    notify,
    removeAlert,
    tripAlertKey,
  } from "@/lib/client/alerts";
  import { currentInstallKind, IOS_INSTALL_HINT } from "@/lib/client/install";
  import { holdWakeLock } from "@/lib/client/wakeLock";
  import {
    computeEta,
    countdown,
    delayClass,
    delayStatus,
    delayTxt,
    detectLoopStops,
    displayStopName,
    formatPlatform,
    formatPrzezLoop,
    hhmmFromSecs,
    isBusStation,
    isMzk,
    notStartedEta,
    operatorColor,
    secsFromHHMM,
    transitMode,
    tripTimeMatchesStop,
    withoutRequestTail,
  } from "@/lib/client/format";
  import { CITY, cityOfId } from "@/lib/client/city";
  import { findActiveStop, type ActiveStopResult } from "@/lib/client/geo";
  import type {
    LatLng,
    Stop,
    TripTime,
    TripView as TripViewState,
    Vehicle,
    VehicleFeatures,
  } from "@/lib/client/types";
  import { progressFromVehicle, stopAlongFor } from "@/lib/shared/trip-progress";

  let {
    trip,
    desktop,
    vehMeta,
    liveVeh,
    onBack,
    onClose,
    onFocusStop,
    onLocate,
    following,
    onToggleFollow,
    onRetry,
    onOpenVehicleCard,
    onShowToast,
    initialSnap = "half",
  }: {
    trip: TripViewState;
    desktop: boolean;
    /** vehicle the trip was opened from (extra header context), if any */
    vehMeta: Vehicle | null;
    /** fresh live poll for this trip's vehicle (matched by exec id): advances the
     *  highlighted stop, the "pojazd na" line and the header delay in real time */
    liveVeh: Vehicle | null;
    /** present when the trip was opened from a stop panel: returns to it */
    onBack: (() => void) | null;
    onClose: () => void;
    onFocusStop: (s: Stop) => void;
    /** fly the map to the vehicle (`id` = its fleet track, whose drawn position wins over the raw fix) */
    onLocate: (v: { id: string | null; lat: number; lon: number }) => void;
    /** the map keeps the bus in view (MapApp ends it on a drag or when the trip changes) */
    following: boolean;
    onToggleFollow: () => void;
    onRetry: () => void;
    /** open the MZK vehicle card over the map (closing it returns to this trip) */
    onOpenVehicleCard: (side: string) => void;
    onShowToast: (text: string) => void;
    initialSnap?: "peek" | "half" | "full";
  } = $props();

  /* the features rendered as chips in the menu (ecoVehicle has none, so it must not open an empty row) */
  const SHOWN_FEATURES = [
    "electric",
    "hydrogen",
    "hybrid",
    "airCondition",
    "lowFloor",
    "longVehicle",
    "ticketMachine",
  ] as const satisfies readonly (keyof VehicleFeatures)[];

  /** % of a half-row rail the vehicle has covered; `x` = stop units travelled into that half */
  const railFill = (x: number) => Math.max(0, Math.min(100, x * 200));
  /** the travelled rail: opaque (it covers the line-coloured rail underneath) */
  const RAIL_DONE = "color-mix(in srgb, #fff 16%, var(--color-surface))";
  /** seconds-of-day difference folded into ±12 h (a post-midnight time against a pre-midnight one) */
  const wrapDay = (d: number) => (d > 43200 ? d - 86400 : d < -43200 ? d + 86400 : d);
  const SAFE_PAD = "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)";

  const clock = useNow();
  const now = $derived(clock.current);
  const alertByKey = $derived(new Map(alerts.current.map((a) => [a.key, a])));
  /** alert key of the stop row whose 3/5/10 min picker is open */
  let alertMenu = $state<string | null>(null);
  /* the ⋮ menu's anchor (viewport px) while it is open */
  let menuAt = $state.raw<{ top: number; right: number } | null>(null);
  let menuBtn: HTMLButtonElement | undefined = $state();
  let menuEl: HTMLDivElement | undefined = $state();
  let scrollEl: HTMLDivElement | undefined = $state();

  /* last-known live fix: when the vehicle drops off the 5 s feed mid-view
     (finished/stale/pruned) keep the freshest progress instead of regressing
     to the opening snapshot; reset whenever a different trip is shown */
  type Held = { gen: number; veh: Vehicle | null; vti: number | null };
  let held: Held | null = null;
  const lastLive = $derived.by((): Held => {
    let l: Held = held && held.gen === trip.gen ? held : { gen: trip.gen, veh: null, vti: null };
    if (liveVeh && l.veh !== liveVeh) {
      l = { gen: trip.gen, veh: liveVeh, vti: liveVeh.geo_seq ?? liveVeh.current_stop_sequence ?? l.vti };
    }
    held = l;
    return l;
  });

  const currentVeh = $derived(liveVeh ?? lastLive.veh ?? vehMeta);
  /* the zbiorkom city of the trip (its ids carry the slug); "bb" for KB/MZK */
  const zbCity = $derived(cityOfId(trip.execId) !== "bb" ? cityOfId(trip.execId) : cityOfId(trip.tripId));
  const tripOp = $derived(currentVeh?.operator ?? trip.operator ?? (zbCity !== "bb" ? "GZM" : undefined));
  const isMzkTrip = $derived(isMzk(tripOp, trip.line));
  const isGzmTrip = $derived(tripOp === "GZM");
  /* fleet card key: MZK side number; GZM `<op>_<fleet>` from the vehicle id (side_number is the bare fleet label) */
  const vehId = $derived(currentVeh?.id ?? trip.execId);
  const cardSide = $derived(
    isGzmTrip
      ? vehId?.startsWith("gzm:")
        ? vehId.slice(4)
        : null
      : isMzkTrip
        ? (currentVeh?.side_number ?? null)
        : null,
  );
  const lineColor = $derived(operatorColor(tripOp, trip.line === "…" ? null : trip.line));
  const mode = $derived(transitMode(tripOp, currentVeh?.vehicle_type));
  const loading = $derived(trip.status === "loading");
  const failed = $derived(trip.status === "error");

  const hasLiveCoords = $derived(
    (currentVeh != null && Number.isFinite(currentVeh.lat) && Number.isFinite(currentVeh.lon)) ||
      (trip.vehicle != null && Number.isFinite(trip.vehicle.lat) && Number.isFinite(trip.vehicle.lon)),
  );
  const isLiveWithLoc = $derived(trip.isLive && hasLiveCoords);
  /* MZK bus waiting at the first stop of a course that has not begun: OnTime's delay
     and per-stop times are a placeholder (now - scheduled start): show the schedule,
     "czeka na odjazd" and never a delay (lib/mzk-state.ts) */
  const notStarted = $derived(isLiveWithLoc && currentVeh?.not_started === true);

  /* prefer the live poll's current stop over the snapshot; geo_seq (GPS, sent only while upstream's index is
     stale) beats current_stop_sequence: a stale hint puts a bus on the OUTBOUND leg of a loop */
  const liveVti = $derived(liveVeh?.geo_seq ?? liveVeh?.current_stop_sequence ?? lastLive.vti);

  /* own deriveds so the work below reruns only when these fields change, not on every new trip object */
  const rawTimes = $derived(trip.rawTimes);
  const tripStops = $derived(trip.stops);
  const shapeId = $derived(trip.shapeId);
  const routed = $derived(trip.routed);

  /** schedule index → resolved physical stop (for fly-to on tap and coordinate lookup) */
  const stopByIndex = $derived.by(() => {
    const m = new Map<number, Stop>();
    for (const r of tripStops) m.set(r.t.index, r.s);
    return m;
  });

  /** along-route metres of every stop on the drawn road shape: the same projection the server stores,
   *  so the vehicle's `dist_m` can be read against it. Only when the drawn shape IS the server shape
   *  the vehicle reports (trip.shapeId === liveVeh.shape, checked below); KB only (MZK's index and
   *  odometer come straight from the operator). */
  const stopAlong = $derived.by(() => {
    if (isMzkTrip || !shapeId || !routed) return null;
    const refs = rawTimes.map((t): LatLng | null => {
      const s = stopByIndex.get(t.index);
      return s ? [s.lat, s.lon] : null;
    });
    return stopAlongFor(routed, refs);
  });

  /* Dynamically determine the active stop index (current stop the bus is at/approaching) */
  const activeStop = $derived.by((): ActiveStopResult => {
    const times = rawTimes;
    if (!times.length) return { index: 0, isAtStop: false };

    if (isLiveWithLoc && tripStops.length > 0) {
      const v = liveVeh ?? trip.vehicle;
      if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon)) {
        // the server tracks the vehicle with continuity (twin stops of an out-and-back, a frozen upstream
        // index): its along-route distance says WHERE on the route the bus is, whatever upstream's index says
        const sp = progressFromVehicle(stopAlong, shapeId, liveVeh, liveVti ?? trip.vti);
        if (sp) return { index: sp.index, isAtStop: sp.at, progress: sp.progress };
        return findActiveStop(
          times.map((t) => {
            const s = stopByIndex.get(t.index);
            return s ? { lat: s.lat, lon: s.lon } : null;
          }),
          {
            lat: v.lat,
            lon: v.lon,
            at_stop: liveVeh?.at_stop,
            current_stop_sequence: liveVti ?? trip.vti,
          },
          liveVti ?? trip.vti,
        );
      }
    }

    // Scheduled / no live GPS fix -> calculate from Europe/Warsaw schedule time.
    // A course across midnight: its times run on past 86400 (00:05 after 23:52) and "now" is
    // placed on the course's side of midnight (±12 h around its first stop).
    let carry = 0;
    let last: number | null = null;
    const schedU: Array<number | null> = [];
    for (const t of times) {
      const s = secsFromHHMM(t.departure_time);
      if (s != null) {
        if (last != null && s + carry < last - 43200) carry += 86400;
        last = s + carry;
      }
      schedU.push(s == null ? null : last);
    }
    const first = schedU.find((s) => s != null) ?? null;
    const nowU = carry > 0 && first != null ? first + wrapDay(now - first) : now;
    for (let i = 0; i < times.length; i++) {
      const sched = schedU[i];
      if (sched != null && sched > nowU) {
        if (i === 0) return { index: 0, isAtStop: true, progress: 0 };
        const prevSched = schedU[i - 1];
        const progress =
          prevSched != null ? Math.min(1, Math.max(0, (nowU - prevSched) / (sched - prevSched))) : 0;
        return { index: i, isAtStop: false, progress };
      }
    }
    // All scheduled times in the past -> course completed
    return { index: times.length - 1, isAtStop: true, progress: 1 };
  });

  const vti = $derived(activeStop.index);
  const isAtStop = $derived(activeStop.isAtStop);

  /* "Wysiadam tu": one notification when the bus stands at the stop before the chosen one or has left it.
     Page-only (needs the poll), so the screen stays on while armed; the sheet is keyed by trip.gen, a new
     trip starts clean. The effect below fires it once per arm */
  let alight = $state.raw<{ idx: number; name: string; fired: boolean } | null>(null);
  const armed = $derived(alight != null && !alight.fired);
  $effect(() => {
    const a = alight;
    if (!a || a.fired || !isLiveWithLoc || !(vti >= a.idx || (vti === a.idx - 1 && isAtStop))) return;
    alight = { ...a, fired: true };
    untrack(() => {
      void notify(`Wysiadasz: ${a.name}`, `Linia ${trip.line}, następny przystanek`, `alight:${trip.gen}`, `${location.pathname}${location.search}`);
      navigator.vibrate?.([300, 150, 300]);
      onShowToast(`Następny przystanek: ${a.name}. Wysiadasz.`);
    });
  });
  $effect(() => {
    if (armed) return holdWakeLock();
  });
  /* runs from a tap, so the permission prompt is allowed; without permission the toast and vibration still fire */
  async function pickAlight(idx: number) {
    if (armed && alight?.idx === idx) {
      alight = null;
      return onShowToast("Alarm wysiadania wyłączony.");
    }
    const name = displayStopName(rawTimes[idx].stop_name);
    alight = { idx, name, fired: false };
    if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
    onShowToast(`Powiadomię przed przystankiem ${name}. Zostaw aplikację otwartą.`);
  }

  const activeProgress = $derived(Math.max(0, Math.min(1, activeStop.progress ?? (isAtStop ? 1 : 0.5))));
  /* the vehicle on the rail in stop units: k = at stop k, k + p = between stops k and k + 1 */
  const railPos = $derived(Math.min(rawTimes.length - 1, Math.max(-0.5, isAtStop ? vti : vti - 1 + activeProgress)));
  const headerDelay = $derived(
    notStarted ? null : (currentVeh?.delay ?? rawTimes[vti ?? -1]?.estimate?.time_diff ?? null),
  );
  const direction = $derived(trip.direction || vehMeta?.headsign);
  const loopStops = $derived(detectLoopStops(rawTimes));
  const eta = $derived(
    loading || failed ? "" : notStarted ? notStartedEta(trip, now) : computeEta(trip, now, vti, isAtStop, headerDelay),
  );

  const scrollTargetIdx = $derived.by(() => {
    if (vti == null) return -1;
    const stop = trip.stop;
    if (stop) {
      const tappedIdx = rawTimes.findIndex((t) => tripTimeMatchesStop(t, stop));
      if (tappedIdx >= 0) return tappedIdx;
    }
    return vti;
  });

  /* centre the row inside the list only: scrollIntoView also scrolls every ancestor, including the
     overflow-hidden app root while the sheet is still sliding in */
  $effect(() => {
    // read before the ?. chain: a short-circuit while the list is still loading would drop the dependency
    const idx = scrollTargetIdx;
    const box = scrollEl;
    const row = box?.querySelector("ol")?.children[idx];
    if (!box || !row) return;
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    box.scrollTo({ top: box.scrollTop + r.top - b.top - (box.clientHeight - r.height) / 2, behavior: "smooth" });
  });

  /* close the menu on a tap outside it, on resize, and on Escape before the sheet's own Escape closes the trip */
  $effect(() => {
    if (!menuAt) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuEl?.contains(t) && !menuBtn?.contains(t)) menuAt = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      menuAt = null;
      menuBtn?.focus();
    };
    const onResize = () => (menuAt = null);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  });

  function toggleMenu() {
    const r = menuBtn?.getBoundingClientRect();
    menuAt = menuAt || !r ? null : { top: r.bottom + 6, right: Math.max(12, window.innerWidth - r.right) };
  }

  const feats = $derived(currentVeh?.features);
  const locateFix = $derived(
    currentVeh && Number.isFinite(currentVeh.lat) && Number.isFinite(currentVeh.lon) ? currentVeh : trip.vehicle,
  );
  const hasDetails = $derived(!loading && !failed);

  /* runs from a tap, so the permission prompt is allowed (browsers drop it without a user gesture) */
  async function pickAlert(key: string, stop: Stop, planned: number, leadMin: number) {
    alertMenu = null;
    if (typeof Notification === "undefined")
      return onShowToast(
        currentInstallKind() === "ios"
          ? `Na iPhonie powiadomienia działają w zainstalowanej aplikacji: ${IOS_INSTALL_HINT}.`
          : "Ta przeglądarka nie obsługuje powiadomień.",
      );
    const perm = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (perm !== "granted") return onShowToast("Powiadomienia są zablokowane. Włącz je w ustawieniach przeglądarki.");
    const ok = addAlert({
      key,
      designator: stop.designator,
      stopName: displayStopName(stop.name),
      line: trip.line,
      dest: direction ? displayStopName(direction) : `Linia ${trip.line}`,
      leadMin,
      until: alertUntil(planned),
    });
    onShowToast(
      ok
        ? `Powiadomię ${leadMin} min przed odjazdem linii ${trip.line}.`
        : `Najwyżej ${MAX_ALERTS} powiadomienia naraz. Wyłącz któreś dzwonkiem.`,
    );
  }

  /** One stop row's figures (the tsx computed them inline in the list). */
  function rowOf(t: TripTime, idx: number) {
    const passed = idx < vti;
    const planned = secsFromHHMM(t.departure_time);
    /* passed: the recorded arrival; ahead: the live forecast (the stop's own estimate, else the bus's delay) */
    const forecast = notStarted ? null : (t.estimate?.time_diff ?? headerDelay);
    const actual =
      !isLiveWithLoc || notStarted || planned == null
        ? null
        : passed
          ? (trip.arrived?.[idx] ?? null)
          : forecast != null
            ? planned + forecast
            : null;
    const rowDiff = actual != null && planned != null ? wrapDay(actual - planned) : null;
    let left = actual != null && !passed ? actual - now : Infinity;
    if (left < -43200) left += 86400;
    const coord = stopByIndex.get(t.index);
    const selected = !!trip.stop && tripTimeMatchesStop(t, trip.stop);
    const last = idx === rawTimes.length - 1;
    /* the bell sits only on the stop the trip was opened from: the board there is what the alert watches.
       Not on the last stop: a loop ending where it started arrives there, it never departs */
    const ak = selected && trip.execId ? tripAlertKey(trip.execId, t.index, trip.tripId || currentVeh?.trip_id) : null;
    const al = ak ? alertByKey.get(ak) : undefined;
    const canAlert = al != null || (ak != null && !passed && !last && planned != null);
    return {
      isCurrent: idx === vti,
      passed,
      planned,
      actual,
      rowDiff,
      bigDiff: rowDiff != null && Math.abs(rowDiff) > 60,
      soon: left < 3600 ? countdown(actual, now) : "",
      coord,
      plat: formatPlatform(t.platform, isBusStation(t.stop_name, coord)),
      status: passed && rowDiff != null ? delayStatus(rowDiff) : "",
      selected,
      first: idx === 0,
      last,
      ak,
      al,
      canAlert,
      /* the alight flag on every stop still ahead of a live bus (the bell row keeps its bell) */
      canAlight: isLiveWithLoc && !notStarted && idx > vti && !(canAlert && ak),
      alighting: armed && alight?.idx === idx,
    };
  }
</script>

<!-- Neutral vehicle-feature chip: a fact about the bus, so no colour of its own. -->
{#snippet feature(icon: IconDef, weight: "bold" | "fill", label: string, title?: string)}
  <span class="inline-flex items-center gap-1 rounded-full bg-tint/6 px-2 py-0.5 text-text-mute" {title}>
    <span class="text-[12px]"><Icon {icon} {weight} /></span>
    {label}
  </span>
{/snippet}

<!-- opens at half (2/4) screen so route & map vehicle are both visible; swipe up to 3/4 or down to peek -->
<BottomSheet {desktop} {onClose} ariaLabel={`Trasa linii ${trip.line}`} {initialSnap}>
  {#snippet header()}
    <header class="px-4 pb-3 pt-2 md:pt-4">
      <div class="flex items-center gap-2">
        {#if onBack}
          <IconButton label="Wróć do przystanku" onClick={onBack}>
            <Icon icon={CaretLeftIcon} />
          </IconButton>
        {/if}
        <LineBadge line={trip.line} operator={isGzmTrip ? "GZM" : isMzkTrip ? "MZK" : "KB"} big />
        <div class="min-w-0 flex-1 pl-0.5">
          <h2 class="truncate text-[16px] font-semibold leading-tight tracking-tight text-text">
            {loading ? "Wczytywanie…" : direction ? displayStopName(direction) : `Linia ${trip.line}`}
          </h2>
          <div class="mt-1 flex items-center gap-x-2 text-[12px] text-text-mute">
            {#if isLiveWithLoc && notStarted}
              <span class="inline-flex items-center gap-1.5 font-medium text-late">
                <span class="h-1.5 w-1.5 rounded-full bg-late" aria-hidden="true"></span>
                Czeka na odjazd
              </span>
            {:else if isLiveWithLoc}
              <span class="inline-flex items-center gap-1.5 font-medium text-good">
                <span class="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-good" aria-hidden="true"></span>
                Na żywo
              </span>
            {:else}
              <span class="text-text-faint">Rozkładowy</span>
            {/if}
            {#if isLiveWithLoc && headerDelay != null}
              <span class="font-semibold tabular-nums {delayClass(headerDelay)}">{delayTxt(headerDelay)}</span>
            {/if}
            {#if trip.status === "routing"}
              <span
                class="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-text-faint border-t-text align-[-1px]"
                aria-hidden="true"
              ></span>
            {/if}
          </div>
        </div>
        {#if isLiveWithLoc && locateFix}
          {@const fix = locateFix}
          <IconButton
            label={following ? "Przestań śledzić pojazd" : "Śledź pojazd na mapie"}
            pressed={following}
            onClick={() => {
              if (!following) onLocate({ id: currentVeh?.id ?? trip.execId, lat: fix.lat, lon: fix.lon });
              onToggleFollow();
            }}
          >
            <Icon icon={CrosshairIcon} weight={following ? "fill" : "bold"} />
          </IconButton>
        {/if}
        {#if hasDetails}
          <button
            bind:this={menuBtn}
            type="button"
            aria-label="Szczegóły kursu"
            aria-haspopup="true"
            aria-expanded={menuAt != null}
            onclick={toggleMenu}
            class="tap grid h-11 w-11 shrink-0 place-items-center rounded-full text-[18px] md:h-9 md:w-9 {menuAt
              ? 'bg-tint/10 text-text'
              : 'text-text-mute hover:bg-tint/8 hover:text-text'}"
          >
            <Icon icon={DotsThreeVerticalIcon} weight="bold" />
          </button>
        {/if}
        <IconButton label="Zamknij trasę" onClick={onClose}>
          <Icon icon={XIcon} />
        </IconButton>
      </div>
      {#if hasDetails && menuAt}
        <!-- fixed: the sheet's overflow-hidden would clip it at the peek height. Its pointerdown must not reach
             the header's drag zone -->
        <div
          bind:this={menuEl}
          role="presentation"
          onpointerdown={(e) => e.stopPropagation()}
          class="surface fixed z-20 w-[min(300px,calc(100vw-24px))] overflow-y-auto rounded-[20px] p-2 text-[13.5px] animate-drop"
          style:top="{menuAt.top}px"
          style:right="{menuAt.right}px"
          style:max-height="calc(100dvh - {menuAt.top + 12}px)"
        >
          <div class="flex items-center gap-2 pl-3">
            <span
              class="h-2 w-2 rounded-full {isGzmTrip ? 'bg-gzm' : isMzkTrip ? 'bg-mzk' : 'bg-kb'}"
              aria-hidden="true"
            ></span>
            <span class="flex-1 text-[12px] font-medium text-text-faint">
              {isGzmTrip ? CITY[zbCity].name : isMzkTrip ? "MZK Bielsko-Biała" : "Komunikacja Beskidzka"}
            </span>
            <ShareButton title={`Linia ${trip.line}${direction ? ` → ${displayStopName(direction)}` : ""}`} />
          </div>
          {#if cardSide}
            {@const side = cardSide}
            <a
              href={`/brygady?${zbCity === "gzm" ? "city=gzm&" : ""}tabor=${encodeURIComponent(side)}`}
              onclick={(e) => {
                // a modified click still opens the fleet page in a new tab
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                menuAt = null;
                onOpenVehicleCard(side);
              }}
              class="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-text transition-colors hover:bg-tint/5"
            >
              <Icon icon={CardsIcon} class="text-[17px] text-text-mute" />
              <span class="min-w-0 flex-1">
                <span class="block">Karta pojazdu</span>
                <span class="block truncate text-[12px] tabular-nums text-text-mute"
                  >#{currentVeh?.side_number ?? side}{currentVeh?.model ? ` · ${currentVeh.model}` : ""}</span
                >
              </span>
              <Icon
                icon={ArrowRightIcon}
                class="text-[14px] text-text-faint transition-transform duration-200 group-hover:translate-x-0.5"
              />
            </a>
          {/if}
          {#if loopStops.length > 0}
            <p
              class="flex items-center gap-3 px-3 py-2.5 text-text"
              title={`Kurs realizowany przez pętlę: ${loopStops.map(displayStopName).join(", ")}`}
            >
              <Icon icon={ArrowsClockwiseIcon} class="text-[17px] text-text-mute" />
              <span class="min-w-0 flex-1">
                przez {loopStops.map((l) => formatPrzezLoop(displayStopName(l))).join(", ")}
              </span>
            </p>
          {/if}
          {#if feats && SHOWN_FEATURES.some((k) => feats[k])}
            <div class="mt-1 flex flex-wrap gap-1.5 border-t border-hairline px-3 pb-1.5 pt-3 text-[11.5px]">
              {#if feats.electric}{@render feature(LightningIcon, "fill", "Elektryczny")}{/if}
              {#if feats.hydrogen}{@render feature(DropIcon, "fill", "Wodorowy")}{/if}
              {#if feats.hybrid}{@render feature(LeafIcon, "fill", "Hybryda")}{/if}
              {#if feats.airCondition}{@render feature(SnowflakeIcon, "bold", "Klima", "Klimatyzacja")}{/if}
              {#if feats.lowFloor}{@render feature(WheelchairIcon, "bold", "Niska podłoga")}{/if}
              {#if feats.longVehicle}
                {@render feature(ArrowsHorizontalIcon, "bold", "Przegubowy", "Pojazd przegubowy, 18 m")}
              {/if}
              {#if feats.ticketMachine}{@render feature(TicketIcon, "bold", "Biletomat", "Biletomat na pokładzie")}{/if}
            </div>
          {/if}
        </div>
      {/if}
      {#if trip.note}
        <p class="mt-2.5 inline-block rounded-full bg-late/10 px-2.5 py-0.5 text-[11.5px] font-medium text-late">
          {trip.note}
        </p>
      {/if}
      {#if eta}
        <p class="mt-2.5 rounded-xl bg-tint/5 px-3 py-2 text-[12.5px] tabular-nums text-text-mute" aria-live="polite">
          {eta}
        </p>
      {/if}
    </header>
  {/snippet}

  <div bind:this={scrollEl} class="kb-scroll h-full overflow-y-auto">
    {#if failed}
      <ErrorState {onRetry} message={trip.errorMsg} />
    {:else if loading}
      <div aria-hidden="true" class="px-5 pt-2" style:padding-bottom={SAFE_PAD}>
        {#each { length: 8 }, i (i)}
          <div class="flex items-center gap-4 py-3">
            <div class="skeleton h-3.5 w-10"></div>
            <div class="skeleton h-3 w-3 rounded-full"></div>
            <div class="skeleton h-3.5 flex-1"></div>
          </div>
        {/each}
      </div>
    {:else if rawTimes.length === 0}
      <p class="px-5 pb-6 pt-2 text-[13px] text-text-mute">
        {isLiveWithLoc
          ? "Przewoźnik nie podaje teraz kursu tego pojazdu: skończył kursy na dziś, jedzie do zajezdni albo ma przerwę. Pozycja na mapie jest na żywo."
          : "Brak przystanków tego kursu."}
      </p>
    {:else}
      <ol class="px-4 pt-1" style:padding-bottom={SAFE_PAD}>
        {#each rawTimes as t, idx (`${t.index}-${idx}`)}
          {@const r = rowOf(t, idx)}
          <li>
            <div class="flex items-center rounded-xl {r.selected ? 'bg-primary-dim' : ''}">
              <button
                type="button"
                disabled={!r.coord}
                onclick={() => r.coord && onFocusStop(r.coord)}
                class="flex min-w-0 flex-1 items-stretch gap-3 rounded-xl text-left transition-colors {r.coord
                  ? 'hover:bg-tint/5 active:bg-tint/8'
                  : ''}"
              >
                <!-- time: the plan struck through above the actual one when they differ -->
                <span class="w-12 shrink-0 self-center pl-1 text-right tabular-nums">
                  {#if r.bigDiff}
                    <s class="block text-[11px] leading-tight text-text-faint">{t.departure_time}</s>
                  {/if}
                  <span
                    class="block text-[13px] font-semibold {r.rowDiff != null
                      ? delayClass(r.rowDiff)
                      : r.passed
                        ? 'text-text-faint'
                        : 'text-text'} {r.passed && r.rowDiff != null ? 'opacity-75' : ''}"
                  >
                    {r.actual != null ? hhmmFromSecs(r.actual) : t.departure_time}
                  </span>
                </span>

                <!-- rail: the travelled part muted, the rest in the line colour; the live bus rides on it -->
                <span class="relative w-6 shrink-0 self-stretch" aria-hidden="true">
                  {#if !r.first}
                    <span class="absolute left-1/2 top-0 h-1/2 w-1.5 -translate-x-1/2" style:background={lineColor}>
                      <span
                        class="absolute inset-x-0 top-0 transition-[height] duration-700 ease-out-soft"
                        style:height="{railFill(railPos - idx + 0.5)}%"
                        style:background={RAIL_DONE}
                      ></span>
                    </span>
                  {/if}
                  {#if !r.last}
                    <span class="absolute bottom-0 left-1/2 h-1/2 w-1.5 -translate-x-1/2" style:background={lineColor}>
                      <span
                        class="absolute inset-x-0 top-0 transition-[height] duration-700 ease-out-soft"
                        style:height="{railFill(railPos - idx)}%"
                        style:background={RAIL_DONE}
                      ></span>
                    </span>
                  {/if}
                  <span
                    class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full {r.first || r.last
                      ? 'h-2.5 w-2.5'
                      : 'h-1.5 w-1.5'}"
                    style:background="var(--color-surface)"
                    style:box-shadow="0 0 0 {r.first || r.last ? 3 : 2}px {r.passed ? RAIL_DONE : lineColor}"
                  ></span>
                  {#if isLiveWithLoc && Math.round(railPos) === idx}
                    <span
                      class="absolute left-1/2 z-10 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[14px] text-white transition-[top] duration-700 ease-out-soft"
                      style:top="{50 + (railPos - idx) * 100}%"
                      style:background={lineColor}
                      style:box-shadow="0 0 0 3px var(--color-surface)"
                    >
                      <ModeIcon {mode} />
                    </span>
                  {/if}
                </span>

                <!-- name -->
                <span class="min-w-0 flex-1 self-center py-3">
                  <span class="flex min-w-0 items-center gap-1.5">
                    <span
                      class="truncate text-[13.5px] {r.isCurrent
                        ? 'font-semibold text-text'
                        : r.passed
                          ? 'text-text-faint'
                          : r.selected
                            ? 'font-semibold text-text'
                            : 'font-medium text-text'}"
                    >
                      {displayStopName(r.coord?.onRequest ? withoutRequestTail(t.stop_name) : t.stop_name)}
                    </span>
                    {#if r.coord?.onRequest}
                      <RequestStopTag dim={r.passed} />
                    {/if}
                  </span>
                  {#if r.status || r.plat}
                    <span class="mt-0.5 block truncate text-[12px] text-text-faint"
                      >{#if r.status}<span class={r.rowDiff != null ? delayClass(r.rowDiff) : ""}>{r.status}</span
                        >{/if}{r.status && r.plat ? " · " : ""}{r.plat}</span
                    >
                  {/if}
                </span>
                {#if r.soon}
                  <span class="shrink-0 self-center pr-2 text-[12.5px] font-semibold tabular-nums text-text">
                    {r.soon}
                  </span>
                {/if}
              </button>
              {#if r.canAlert && r.ak}
                {@const ak = r.ak}
                {@const al = r.al}
                <button
                  type="button"
                  aria-label={al ? `Wyłącz powiadomienie ${al.leadMin} min przed` : "Powiadom przed odjazdem"}
                  aria-expanded={al ? undefined : alertMenu === ak}
                  onclick={() => (al ? removeAlert(ak) : (alertMenu = alertMenu === ak ? null : ak))}
                  class="tap grid h-11 w-10 shrink-0 place-items-center rounded-xl text-[17px] hover:bg-tint/5 {al
                    ? 'text-primary'
                    : 'text-text-mute hover:text-text'}"
                >
                  <Icon icon={BellIcon} weight={al ? "fill" : "bold"} />
                </button>
              {/if}
              {#if r.canAlight}
                <button
                  type="button"
                  aria-pressed={r.alighting}
                  aria-label={r.alighting ? "Wyłącz alarm wysiadania" : "Powiadom przed tym przystankiem"}
                  onclick={() => void pickAlight(idx)}
                  class="tap grid h-11 w-10 shrink-0 place-items-center rounded-xl text-[16px] hover:bg-tint/5 {r.alighting
                    ? 'text-primary'
                    : 'text-text-faint hover:text-text'}"
                >
                  <Icon icon={FlagIcon} weight={r.alighting ? "fill" : "bold"} />
                </button>
              {/if}
            </div>
            {#if r.ak && !r.al && alertMenu === r.ak && trip.stop && r.planned != null}
              {@const ak = r.ak}
              {@const stop = trip.stop}
              {@const planned = r.planned}
              <!-- aligned with the stop names, the rail runs on beside it -->
              <div class="flex items-stretch gap-3">
                <span class="w-12 shrink-0" aria-hidden="true"></span>
                <span class="relative w-6 shrink-0" aria-hidden="true">
                  {#if !r.last}
                    <span class="absolute inset-y-0 left-1/2 w-1.5 -translate-x-1/2" style:background={lineColor}></span>
                  {/if}
                </span>
                <div
                  role="group"
                  aria-label="Powiadom przed odjazdem"
                  class="flex min-w-0 flex-1 flex-wrap items-center gap-2 py-2 text-[12px]"
                >
                  {#each ALERT_LEADS as m (m)}
                    <button
                      type="button"
                      onclick={() => void pickAlert(ak, stop, planned, m)}
                      class="tap min-h-8 rounded-full bg-tint/8 px-3 font-medium text-text hover:bg-tint/12"
                    >
                      {m} min przed
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</BottomSheet>
