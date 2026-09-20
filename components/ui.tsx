"use client";

import { useCallback, useState } from "react";
import { operatorColor } from "@/lib/client/format";

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
      className={`flex shrink-0 items-center justify-center rounded-lg font-bold text-white ${
        big ? "h-8 min-w-11 px-2 text-[15px]" : "h-7 min-w-9 px-1.5 text-xs"
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
      className={`grid h-11 w-11 shrink-0 place-items-center rounded-full transition-all hover:bg-white/8 hover:text-text active:scale-90 md:h-9 md:w-9 ${
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
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={filled ? "animate-pop" : undefined}
    >
      <path d="M12 2.5l2.94 5.96 6.58.96-4.76 4.64 1.12 6.55L12 17.52l-5.88 3.09 1.12-6.55L2.48 9.42l6.58-.96L12 2.5z" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 13.5 6.8 3.98M15.4 6.5 8.6 10.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** Shares the CURRENT url (deep-link state keeps it fresh) via the native share
 *  sheet, falling back to clipboard + a 2 s "copied" check. Self-contained on
 *  purpose: no new props on the memo()-ized sheets. */
export function ShareButton({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);
  const onShare = useCallback(async () => {
    const url = window.location.href;
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
  }, [title]);
  return (
    <IconButton label={copied ? "Skopiowano link" : "Udostępnij"} onClick={() => void onShare()} pressed={copied}>
      {copied ? <CheckIcon /> : <ShareIcon />}
    </IconButton>
  );
}

export function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

export function SkeletonRows() {
  return (
    <div aria-hidden className="px-4">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-hairline py-3.5 last:border-0">
          <div className="skeleton h-7 w-9" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3 w-3/4" />
            <div className="skeleton h-2.5 w-1/2" />
          </div>
          <div className="skeleton h-6 w-14" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="mx-auto text-text-faint" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M8 14s1.5 1.5 4 1.5 4-1.5 4-1.5" transform="rotate(180 12 14.75)" />
        <path d="M9 9.5h.01M15 9.5h.01" strokeWidth="2.2" />
      </svg>
      <p className="mt-3 text-[13px] text-text-mute">{text}</p>
    </div>
  );
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-[13px] text-danger">Nie udało się pobrać danych.</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-full bg-brand px-4 py-2 text-xs font-semibold text-on-brand transition-all hover:bg-brand-hi active:scale-95"
      >
        Spróbuj ponownie
      </button>
    </div>
  );
}
