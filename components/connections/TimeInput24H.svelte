<script lang="ts">
  /**
   * 24-Hour Time Input Component
   * Strictly enforces 24-hour format (00:00 - 23:59) across all devices and browsers,
   * preventing any browser-level AM/PM interference.
   */
  let {
    hour,
    minute,
    onChange,
    onBlur,
  }: {
    hour: string;
    minute: string;
    onChange: (h: string, m: string) => void;
    onBlur?: () => void;
  } = $props();

  let hourEl: HTMLInputElement | undefined = $state();
  let minEl: HTMLInputElement | undefined = $state();

  /* at most two digits; a rejected keystroke leaves the field as it was, so it never shows what onChange was not given */
  function digits(el: HTMLInputElement): string {
    const raw = el.value.replace(/\D/g, "").slice(0, 2);
    if (el.value !== raw) el.value = raw;
    return raw;
  }

  function handleHourChange(e: Event & { currentTarget: HTMLInputElement }) {
    const raw = digits(e.currentTarget);
    onChange(raw, minute);
    if (raw.length === 2 || (raw.length === 1 && Number(raw) >= 3)) {
      minEl?.focus();
      minEl?.select();
    }
  }

  function handleMinChange(e: Event & { currentTarget: HTMLInputElement }) {
    onChange(hour, digits(e.currentTarget));
  }

  function handleHourKeyDown(e: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = (parseInt(hour || "0", 10) + 1) % 24;
      onChange(String(n).padStart(2, "0"), minute);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = (parseInt(hour || "0", 10) + 23) % 24;
      onChange(String(n).padStart(2, "0"), minute);
    } else if (e.key === "ArrowRight" && e.currentTarget.selectionStart === e.currentTarget.value.length) {
      minEl?.focus();
    }
  }

  function handleMinKeyDown(e: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = (parseInt(minute || "0", 10) + 5) % 60;
      onChange(hour, String(n).padStart(2, "0"));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = (parseInt(minute || "0", 10) + 55) % 60;
      onChange(hour, String(n).padStart(2, "0"));
    } else if (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0) {
      hourEl?.focus();
    } else if (e.key === "Backspace" && !minute) {
      hourEl?.focus();
    }
  }
</script>

<div
  class="flex h-8 items-center rounded-full bg-tint/6 px-3 text-text transition-colors focus-within:bg-tint/10 focus-within:ring-1 focus-within:ring-primary/50"
>
  <input
    bind:this={hourEl}
    type="text"
    inputmode="numeric"
    pattern="[0-9]*"
    maxlength={2}
    value={hour}
    oninput={handleHourChange}
    onkeydown={handleHourKeyDown}
    onblur={onBlur}
    class="w-6 bg-transparent text-center text-base font-semibold tabular-nums outline-none ring-0 placeholder:text-text-faint focus:outline-none focus:ring-0 focus-visible:outline-none md:w-5 md:text-[13px]"
    placeholder="00"
    aria-label="Godzina w formacie 24-godzinnym (00-23)"
  />
  <span class="select-none px-0.5 font-semibold text-text-faint">:</span>
  <input
    bind:this={minEl}
    type="text"
    inputmode="numeric"
    pattern="[0-9]*"
    maxlength={2}
    value={minute}
    oninput={handleMinChange}
    onkeydown={handleMinKeyDown}
    onblur={onBlur}
    class="w-6 bg-transparent text-center text-base font-semibold tabular-nums outline-none ring-0 placeholder:text-text-faint focus:outline-none focus:ring-0 focus-visible:outline-none md:w-5 md:text-[13px]"
    placeholder="00"
    aria-label="Minuty w formacie 24-godzinnym (00-59)"
  />
</div>
