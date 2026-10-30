"use client";

import { useCallback, useId, useState } from "react";
import {
  ArrowsClockwiseIcon,
  BusIcon,
  CaretLeftIcon,
  CheckIcon,
  RssSimpleIcon,
  ShareNetworkIcon,
  StarIcon as PhStarIcon,
  TramIcon,
  WarningCircleIcon,
  XIcon,
} from "@/components/icons";
import { operatorColor, type TransitMode } from "@/lib/client/format";

/* Shared with /brygady, which has no IconContext: weight and aria-hidden are
   explicit here instead of inherited. Icons size to the button's font-size. */

/* Chips: one height, one radius. "On" uses the same accent as a pressed IconButton. */
export const CHIP = "tap inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full text-[12px] font-medium";
export const CHIP_ON = "bg-primary-dim text-primary";
export const CHIP_OFF = "bg-tint/6 text-text-mute hover:bg-tint/10 hover:text-text";
export const chip = (on: boolean) => `${CHIP} px-3 ${on ? CHIP_ON : CHIP_OFF}`;

/** Colored line-number pill, size-adjustable. */
export function LineBadge({
  line,
  big = false,
  operator,
}: {
  line: string;
  big?: boolean;
  operator?: "KB" | "MZK" | "GZM";
}) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg font-semibold tabular-nums tracking-tight text-white ${
        big ? "h-8 min-w-11 px-2 text-[15px]" : "h-7 min-w-9 px-1.5 text-[12px]"
      }`}
      style={{ background: operatorColor(operator, line) }}
    >
      {line}
    </span>
  );
}

/** Radio group drawn as one pill track; the checked segment lifts onto surface-3. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; title?: string; lead?: React.ReactNode }[];
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex rounded-full bg-tint/5 p-1" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.id)}
            className={`tap inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full text-[12.5px] font-medium ${
              on ? "bg-surface-3 text-text shadow-sm" : "text-text-mute hover:text-text"
            }`}
          >
            {o.lead}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Marks a time that comes from the bus on the road (GPS), not from the timetable. */
export function LiveMark() {
  return (
    <>
      <RssSimpleIcon size="1em" weight="bold" aria-hidden className="shrink-0 text-[0.75em]" />
      <span className="sr-only">na żywo, </span>
    </>
  );
}

export function IconButton({
  label,
  onClick,
  children,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  /** for toggle buttons (adds aria-pressed and keeps the icon colored) */
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      className={`tap grid h-11 w-11 shrink-0 place-items-center rounded-full text-[18px] hover:bg-tint/8 hover:text-text md:h-9 md:w-9 ${
        pressed ? "text-primary" : "text-text-mute"
      }`}
    >
      {children}
    </button>
  );
}

/** Favorite star — filled when active. */
export function StarIcon({ filled = false }: { filled?: boolean }) {
  return (
    <PhStarIcon
      size="1em"
      weight={filled ? "fill" : "bold"}
      aria-hidden
      className={filled ? "animate-pop" : undefined}
    />
  );
}

/** Shares the CURRENT url (deep-link state keeps it fresh) via the native share
 *  sheet, falling back to clipboard + a 2 s "copied" check. Self-contained on
 *  purpose: no new props on the memo()-ized sheets. */
/** Shares `path` (resolved against this page), else the page itself. */
export function ShareButton({ title, path }: { title: string; path?: string }) {
  const [copied, setCopied] = useState(false);
  const onShare = useCallback(async () => {
    const url = path ? new URL(path, window.location.href).href : window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
      } catch {
        /* user cancelled the share sheet */
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — nothing sensible to do */
    }
  }, [title, path]);
  return (
    <IconButton label={copied ? "Skopiowano link" : "Udostępnij"} onClick={() => void onShare()} pressed={copied}>
      {copied ? (
        <CheckIcon size="1em" weight="bold" aria-hidden className="animate-pop" />
      ) : (
        <ShareNetworkIcon size="1em" weight="bold" aria-hidden />
      )}
    </IconButton>
  );
}

export function CloseIcon() {
  return <XIcon size="1em" weight="bold" aria-hidden />;
}

export function BackIcon() {
  return <CaretLeftIcon size="1em" weight="bold" aria-hidden />;
}

/** Placeholder rows shaped like the departure / timetable rows they precede. */
export function SkeletonRows() {
  return (
    <div aria-hidden className="px-4 pt-1">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 py-3">
          <div className="skeleton h-7 w-9 rounded-lg" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3 w-3/4" />
            <div className="skeleton h-2.5 w-1/2" />
          </div>
          <div className="skeleton h-5 w-12" />
        </div>
      ))}
    </div>
  );
}

/** Bus, tram or trolleybus glyph at the font size (Phosphor has no trolleybus: its bus under two poles, as on the map pill). */
export function ModeIcon({ mode, weight = "fill" }: { mode: TransitMode; weight?: "fill" | "bold" }) {
  if (mode === "tram") return <TramIcon size="1em" weight={weight} aria-hidden />;
  if (mode === "bus") return <BusIcon size="1em" weight={weight} aria-hidden />;
  return (
    <svg width="1em" height="1em" viewBox="0 0 256 256" fill="currentColor" aria-hidden>
      <g transform="translate(32 56) scale(0.75)">
        <BusIcon size={256} weight={weight} />
      </g>
      <path d="M108 80 76 16M148 80 116 16" fill="none" stroke="currentColor" strokeWidth={16} strokeLinecap="round" />
    </svg>
  );
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="px-6 py-12 text-center animate-fade">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-tint/5 text-[22px] text-text-faint">
        <BusIcon size="1em" weight="bold" aria-hidden />
      </span>
      <p className="mt-3 text-[13px] text-text-mute">{text}</p>
    </div>
  );
}

export function ErrorState({ onRetry, message }: { onRetry: () => void; message?: string }) {
  return (
    <div className="px-6 py-10 text-center animate-fade">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-danger/10 text-[22px] text-danger">
        <WarningCircleIcon size="1em" weight="bold" aria-hidden />
      </span>
      <p className="mt-3 text-[13px] text-text-mute">{message ?? "Nie udało się pobrać danych."}</p>
      <button
        type="button"
        onClick={onRetry}
        className="tap mt-4 inline-flex items-center gap-1.5 rounded-full bg-tint/8 px-4 py-2 text-[13px] font-medium text-text hover:bg-tint/12"
      >
        <ArrowsClockwiseIcon size="1em" weight="bold" aria-hidden />
        Spróbuj ponownie
      </button>
    </div>
  );
}

/** One settings toggle row (role="switch"), optionally with a hint line. */
export function SwitchRow({
  checked,
  onToggle,
  label,
  hint,
  badge,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  hint?: string;
  badge?: string;
}) {
  const hintId = useId();
  return (
    <button
      type="button"
      onClick={onToggle}
      role="switch"
      aria-checked={checked}
      aria-describedby={hint ? hintId : undefined}
      className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-tint/5"
    >
      <span className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2 text-text">
          {label}
          {badge && (
            <span className="shrink-0 rounded-full bg-tint/6 px-1.5 py-px text-[10.5px] font-medium text-text-mute">
              {badge}
            </span>
          )}
        </span>
        {hint && (
          <span id={hintId} className="text-[12px] leading-snug text-text-faint">
            {hint}
          </span>
        )}
      </span>
      <span
        className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full px-[3px] transition-colors duration-200 ${
          checked ? "bg-primary" : "bg-tint/12"
        }`}
        aria-hidden
      >
        <span
          className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-spring ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}
