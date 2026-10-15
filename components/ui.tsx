"use client";

import { useCallback, useState } from "react";
import {
  ArrowsClockwiseIcon,
  BusIcon,
  CaretLeftIcon,
  CheckIcon,
  ShareNetworkIcon,
  StarIcon as PhStarIcon,
  WarningCircleIcon,
  XIcon,
} from "@/components/icons";
import { operatorColor } from "@/lib/client/format";

/* Shared with /brygady, which has no IconContext: weight and aria-hidden are
   explicit here instead of inherited. Icons size to the button's font-size. */

/** Colored line-number pill, size-adjustable. */
export function LineBadge({
  line,
  big = false,
  operator,
}: {
  line: string;
  big?: boolean;
  operator?: "KB" | "MZK";
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
      className={`tap grid h-11 w-11 shrink-0 place-items-center rounded-full text-[18px] hover:bg-white/8 hover:text-text md:h-9 md:w-9 ${
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

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="px-6 py-12 text-center animate-fade">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-white/5 text-[22px] text-text-faint">
        <BusIcon size="1em" weight="bold" aria-hidden />
      </span>
      <p className="mt-3 text-[13px] text-text-mute">{text}</p>
    </div>
  );
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="px-6 py-10 text-center animate-fade">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-danger/10 text-[22px] text-danger">
        <WarningCircleIcon size="1em" weight="bold" aria-hidden />
      </span>
      <p className="mt-3 text-[13px] text-text-mute">Nie udało się pobrać danych.</p>
      <button
        type="button"
        onClick={onRetry}
        className="tap mt-4 inline-flex items-center gap-1.5 rounded-full bg-white/8 px-4 py-2 text-[13px] font-medium text-text hover:bg-white/12"
      >
        <ArrowsClockwiseIcon size="1em" weight="bold" aria-hidden />
        Spróbuj ponownie
      </button>
    </div>
  );
}
