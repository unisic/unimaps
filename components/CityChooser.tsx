"use client";

import { useMemo, useState, type ReactNode } from "react";

import { CaretRightIcon, CheckIcon, MagnifyingGlassIcon, MapTrifoldIcon } from "@/components/icons";
import { CITY, OTHER_CITIES, type City } from "@/lib/client/city";
import { normalizeText } from "@/lib/client/format";

/** The "Inne miasto" subtitle: the five biggest by name, the rest as a count. */
export const OTHERS_HINT = `Warszawa, Kraków, Łódź, Wrocław, Poznań i ${OTHER_CITIES.length - 5} innych`;

/* one card layout for every row: an icon, a bold name, a muted second line; `big` is the first-screen size */
function Card({
  big = false,
  current = false,
  icon,
  name,
  sub,
  trailing,
  onClick,
}: {
  big?: boolean;
  current?: boolean;
  icon: ReactNode;
  name: string;
  sub: string;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? "true" : undefined}
      className={
        big
          ? "flex w-full items-center gap-4 rounded-2xl border border-hairline bg-surface p-4 text-left transition-colors hover:bg-surface-2"
          : `tap flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-tint/5 ${
              current ? "bg-tint/5" : ""
            }`
      }
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`font-semibold text-text ${big ? "text-base" : "text-[13.5px]"}`}>{name}</span>
        <span className={`text-text-mute ${big ? "text-sm" : "text-[12px]"}`}>{sub}</span>
      </span>
      {current && <CheckIcon className="shrink-0 text-[16px] text-primary" weight="bold" aria-hidden />}
      {trailing}
    </button>
  );
}

/** A city as a card: its logo, name and operator line; the page's city carries a check mark. */
export function CityCard({
  id,
  big,
  current,
  trailing,
  onClick,
}: {
  id: City;
  big?: boolean;
  current?: boolean;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  const c = CITY[id];
  return (
    <Card
      big={big}
      current={current}
      name={c.name}
      sub={c.agency}
      trailing={trailing}
      onClick={onClick}
      icon={
        c.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={c.logo}
            alt=""
            className={`${big ? "h-12 w-12" : "h-9 w-9"} shrink-0 object-contain ${
              c.logo.startsWith("/logos/") ? "rounded-xl bg-white p-1 ring-1 ring-hairline" : ""
            }`}
            draggable={false}
          />
        ) : (
          <span
            aria-hidden
            className={`grid shrink-0 place-items-center rounded-full bg-tint/6 font-semibold text-text-mute ${
              big ? "h-12 w-12 text-[20px]" : "h-9 w-9 text-[15px]"
            }`}
          >
            {c.name.charAt(0)}
          </span>
        )
      }
    />
  );
}

/** A caret for a card that opens the list of other cities. */
export function OpensMore() {
  return <CaretRightIcon className="shrink-0 text-[15px] text-text-faint" weight="bold" aria-hidden />;
}

/** The "Inne miasto" card: a generic map icon, it opens `OtherCities`. */
export function OthersCard({ big, onClick }: { big?: boolean; onClick: () => void }) {
  return (
    <Card
      big={big}
      name="Inne miasto"
      sub={OTHERS_HINT}
      trailing={<OpensMore />}
      onClick={onClick}
      icon={
        <span
          className={`grid shrink-0 place-items-center rounded-full bg-tint/6 text-text-mute ${
            big ? "h-12 w-12 text-[24px]" : "h-9 w-9 text-[18px]"
          }`}
        >
          <MapTrifoldIcon weight="bold" aria-hidden />
        </span>
      }
    />
  );
}

/**
 * Every city but BB and GZM (those two have cards of their own), filtered by name or operator without
 * regard to diacritics. `listClassName` caps and scrolls the list where the host does not scroll itself.
 */
export function OtherCities({
  current,
  onPick,
  autoFocus = false,
  listClassName = "",
}: {
  current?: City;
  onPick: (c: City) => void;
  autoFocus?: boolean;
  listClassName?: string;
}) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const n = normalizeText(q.trim());
    if (!n) return OTHER_CITIES;
    return OTHER_CITIES.filter((c) => normalizeText(`${c.label} ${CITY[c.id].agency}`).includes(n));
  }, [q]);
  return (
    <>
      <label className="flex h-10 items-center gap-2.5 rounded-xl bg-tint/6 px-3.5 text-text-mute transition-colors focus-within:bg-tint/10 focus-within:ring-1 focus-within:ring-primary/50">
        <MagnifyingGlassIcon className="shrink-0 text-[16px]" weight="bold" aria-hidden />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Miasto lub przewoźnik…"
          aria-label="Szukaj miasta"
          autoComplete="off"
          autoFocus={autoFocus}
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-text outline-none placeholder:text-text-faint"
        />
      </label>
      {list.length === 0 ? (
        <p className="px-3 py-6 text-center text-[13px] text-text-mute">Brak takiego miasta.</p>
      ) : (
        <ul className={`mt-2 ${listClassName}`}>
          {list.map((c) => (
            <li key={c.id}>
              <CityCard id={c.id} current={c.id === current} onClick={() => onPick(c.id)} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
