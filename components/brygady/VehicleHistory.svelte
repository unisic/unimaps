<script lang="ts">
  import LineBadge from "@/components/ui/LineBadge.svelte";
  import { cityOfSide, isNotFound } from "@/lib/client/fleet";
  import { useVehicleHistory } from "@/lib/client/fleet.svelte";
  import { compareLineNames, type FleetHistoryDay, type FleetVehicleDetail } from "@/lib/shared/fleet";

  import Block from "./Block.svelte";
  import { clockFromSecs, fmtDay, fmtDelayMin, fmtKm, pluralPl } from "./common";
  import DelayBadge from "./DelayBadge.svelte";
  import { CHEVRON_DOWN } from "./icons";
  import Svg from "./Svg.svelte";

  /** The vehicle's past days from /api/fleet/<side>/history: which courses it ran, day by day. */
  let { side, operator }: { side: string; operator: FleetVehicleDetail["operator"] } = $props();

  const uid = $props.id();
  // svelte-ignore state_referenced_locally
  const history = useVehicleHistory(() => side, cityOfSide(side));
  const days = $derived(history.data?.days ?? []);
  let open = $state.raw<ReadonlySet<string>>(new Set());

  function toggle(date: string) {
    const next = new Set(open);
    if (next.has(date)) next.delete(date);
    else next.add(date);
    open = next;
  }

  /** courses per line over every day held, most first */
  const lineCounts = $derived.by(() => {
    const m = new Map<string, number>();
    for (const d of days) for (const c of d.courses) m.set(c.lineName, (m.get(c.lineName) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || compareLineNames(a[0], b[0]));
  });

  function daySummary(d: FleetHistoryDay) {
    let km = 0;
    let cancelled = 0;
    let delay = 0;
    let measured = 0;
    const lines: string[] = [];
    for (const c of d.courses) {
      km += c.drivenMeters / 1000;
      if (c.status === "cancelled") cancelled++;
      else {
        delay += c.delaySec;
        measured++;
      }
      if (!lines.includes(c.lineName)) lines.push(c.lineName);
    }
    return { km, cancelled, avgDelay: measured > 0 ? delay / measured : null, lines };
  }
</script>

<Block title="Historia kursów">
  {#snippet aside()}
    {#if days.length > 0}
      <span class="text-[12px] text-text-mute tabular-nums">
        {days.length} {pluralPl(days.length, "dzień", "dni", "dni")}
      </span>
    {/if}
  {/snippet}
  {#if history.error && !isNotFound(history.error) && !history.data}
    <p class="text-[13px] text-text-mute">Nie udało się wczytać historii. Spróbujemy ponownie za chwilę.</p>
  {:else if !history.data}
    <p class="text-[13px] text-text-mute">Wczytywanie historii…</p>
  {:else if days.length === 0}
    <p class="text-[13px] text-text-mute">
      {history.data.complete ? "Brak zapisanych kursów z poprzednich dni." : "Wczytywanie zapisanych dni…"}
    </p>
  {:else}
    <ul class="mb-3 flex flex-wrap gap-x-3 gap-y-2" aria-label="Linie w zapisanych dniach">
      {#each lineCounts.slice(0, 10) as [line, n] (line)}
        <li class="flex items-center gap-1.5">
          <LineBadge {line} {operator} />
          <span class="text-[12px] text-text-mute tabular-nums">{n}×</span>
        </li>
      {/each}
      {#if lineCounts.length > 10}
        <li class="self-center text-[12px] text-text-faint">i {lineCounts.length - 10} innych</li>
      {/if}
    </ul>
    <ul class="-mx-1 divide-y divide-hairline">
      {#each days as d (d.date)}
        {@const s = daySummary(d)}
        {@const isOpen = open.has(d.date)}
        <li>
          <button
            type="button"
            aria-expanded={isOpen}
            aria-controls="{uid}-{d.date}"
            onclick={() => toggle(d.date)}
            class="flex min-h-12 w-full items-center gap-3 rounded-lg px-1 py-2 text-left transition-colors hover:bg-tint/5"
          >
            <span class="w-[4.75rem] shrink-0 text-[12.5px] font-medium text-text sm:w-[5.5rem]">{fmtDay(d.date)}</span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13px] text-text">
                {pluralPl(s.lines.length, "linia", "linie", "linii")} {s.lines.join(", ")}
              </span>
              <span class="block text-[11.5px] text-text-faint tabular-nums">
                {[
                  `${d.courses.length} ${pluralPl(d.courses.length, "kurs", "kursy", "kursów")}`,
                  s.km > 0 ? fmtKm(s.km) : null,
                  s.avgDelay !== null ? `śr. ${fmtDelayMin(s.avgDelay)}` : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </span>
            </span>
            {#if s.cancelled > 0}
              <span class="shrink-0 rounded-md bg-danger/12 px-1.5 py-0.5 text-[12px] font-semibold text-danger tabular-nums">
                {s.cancelled} {pluralPl(s.cancelled, "przerwany", "przerwane", "przerwanych")}
              </span>
            {/if}
            <Svg icon={CHEVRON_DOWN} size={16} class="shrink-0 text-text-faint transition-transform {isOpen ? 'rotate-180' : ''}" />
          </button>
          <ul id="{uid}-{d.date}" hidden={!isOpen} class="pb-2">
            {#if isOpen}
              {#each d.courses as c, i (i)}
                {@const time = `${clockFromSecs(c.startSecs)}–${clockFromSecs(c.endSecs)}`}
                {@const extra = [c.brigade ? `brygada ${c.brigade}` : null, c.status === "cancelled" && c.cancelledAtStopName ? `przerwany: ${c.cancelledAtStopName}` : null]
                  .filter(Boolean)
                  .join(", ")}
                <li class="flex min-h-10 items-center gap-3 px-1 py-1.5">
                  <!-- as in the road card: on a phone the time leads the second line -->
                  <span class="hidden w-[5.5rem] shrink-0 text-[12.5px] text-text-mute tabular-nums sm:block">{time}</span>
                  <LineBadge line={c.lineName} {operator} />
                  <span class="min-w-0 flex-1">
                    <span class="line-clamp-2 text-[13px] text-text">{c.firstStopName} → {c.lastStopName}</span>
                    <span class="block truncate text-[11.5px] text-text-faint tabular-nums">
                      <span class="text-text-mute sm:hidden">{time}{extra ? ", " : ""}</span>{extra}
                    </span>
                  </span>
                  {#if c.status === "cancelled"}
                    <span class="shrink-0 rounded-md bg-danger/12 px-1.5 py-0.5 text-[12px] font-semibold text-danger">Przerwany</span>
                  {:else}
                    <DelayBadge sec={c.delaySec} />
                  {/if}
                </li>
              {/each}
            {/if}
          </ul>
        </li>
      {/each}
    </ul>
    {#if !history.data.complete}
      <p class="mt-2 text-[12px] text-text-faint">Wczytywanie starszych dni…</p>
    {/if}
  {/if}
</Block>
