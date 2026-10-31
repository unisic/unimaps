/**
 * Leaflet divIcon factories: the vehicle pill (rotating heading arrow, operator
 * logo and line number on the operator colour), stop / station markers, the selected-stop
 * ping, the user location dot and the journey pins.
 * CLIENT-ONLY: imports leaflet, must only be reached from ssr:false trees.
 */
import L from "leaflet";
import { CITY, getPageCity } from "@/lib/client/city";
import type { TransitMode } from "./format";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/*
 * Glyph paths from Phosphor Icons (@phosphor-icons/core 2.1.1, 256x256 grid),
 * MIT License, Copyright (c) 2023 Phosphor Icons. divIcons are HTML strings,
 * so the React components from @phosphor-icons/react cannot be used here; the
 * paths are the same family the UI chrome uses.
 */
const PH_BUS_FILL =
  "M248,80v24a8,8,0,0,1-16,0V80a8,8,0,0,1,16,0ZM16,72a8,8,0,0,0-8,8v24a8,8,0,0,0,16,0V80A8,8,0,0,0,16,72Zm200-8V208a16,16,0,0,1-16,16H184a16,16,0,0,1-16-16v-8H88v8a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V64A32,32,0,0,1,72,32H184A32,32,0,0,1,216,64ZM104,148a12,12,0,1,0-12,12A12,12,0,0,0,104,148Zm72,0a12,12,0,1,0-12,12A12,12,0,0,0,176,148Zm24-76H56v40H200Z";
/** navigation-arrow-fill: drawn pointing north-west, turned 45deg inside the SVG so 0deg = north */
const PH_NAV_ARROW_FILL =
  "M248,121.58a15.76,15.76,0,0,1-11.29,15l-.2.06-78,21.84-21.84,78-.06.2a15.77,15.77,0,0,1-15,11.29h-.3a15.77,15.77,0,0,1-15.07-10.67L41,61.41a1,1,0,0,1-.05-.16A16,16,0,0,1,61.25,40.9l.16.05,175.92,65.26A15.78,15.78,0,0,1,248,121.58Z";
const PH_TRAM_FILL =
  "M184,48H136V24h32a8,8,0,0,0,0-16H88a8,8,0,0,0,0,16h32V48H72A32,32,0,0,0,40,80V184a32,32,0,0,0,32,32h8L65.6,235.2a8,8,0,1,0,12.8,9.6L100,216h56l21.6,28.8a8,8,0,1,0,12.8-9.6L176,216h8a32,32,0,0,0,32-32V80A32,32,0,0,0,184,48Zm0,152H72a16,16,0,0,1-16-16V128H200v56A16,16,0,0,1,184,200ZM96,172a12,12,0,1,1-12-12A12,12,0,0,1,96,172Zm88,0a12,12,0,1,1-12-12A12,12,0,0,1,184,172Z";
const PH_SUBWAY_FILL =
  "M156,176V152h20v16a8,8,0,0,1-8,8Zm-16,0V152H116v24Zm36-88a8,8,0,0,0-8-8H88a8,8,0,0,0-8,8v48h96ZM152,24H104A72,72,0,0,0,32,96V208a8,8,0,0,0,8,8H76.58a4,4,0,0,0,3.58-2.21L91.06,192H88a24,24,0,0,1-24-24V88A24,24,0,0,1,88,64h80a24,24,0,0,1,24,24v80a24,24,0,0,1-24,24h-3.06l10.9,21.79a4,4,0,0,0,3.58,2.21H216a8,8,0,0,0,8-8V96A72,72,0,0,0,152,24Zm-4.94,168H108.94l-9.1,18.21a4,4,0,0,0,3.58,5.79h49.16a4,4,0,0,0,3.58-5.79ZM80,168a8,8,0,0,0,8,8h12V152H80Z";
const PH_CARET_UP_FILL =
  "M215.39,163.06A8,8,0,0,1,208,168H48a8,8,0,0,1-5.66-13.66l80-80a8,8,0,0,1,11.32,0l80,80A8,8,0,0,1,215.39,163.06Z";
const PH_PERSON_WALK_BOLD =
  "M152,84a36,36,0,1,0-36-36A36,36,0,0,0,152,84Zm0-48a12,12,0,1,1-12,12A12,12,0,0,1,152,36Zm68,112a12,12,0,0,1-12,12c-37,0-55.27-18.47-70-33.3-1.71-1.72-3.36-3.4-5-5l-8.63,19.85L159,166.23a12,12,0,0,1,5,9.77v56a12,12,0,0,1-24,0V182.17l-25.37-18.12L83,236.78a12,12,0,1,1-22-9.57l50.06-115.13q-10.64.75-25,8.4a159.78,159.78,0,0,0-29.83,21.23,12,12,0,0,1-16.43-17.5c2.61-2.45,64.36-59.67,104.09-25.18,3.94,3.42,7.64,7.16,11.22,10.78C168.43,123.28,181,136,208,136A12,12,0,0,1,220,148Z";
const PH_ARROWS_LEFT_RIGHT_BOLD =
  "M216.49,184.49l-32,32a12,12,0,0,1-17-17L179,188H48a12,12,0,0,1,0-24H179l-11.52-11.51a12,12,0,0,1,17-17l32,32A12,12,0,0,1,216.49,184.49Zm-145-64a12,12,0,0,0,17-17L77,92H208a12,12,0,0,0,0-24H77L88.49,56.49a12,12,0,0,0-17-17l-32,32a12,12,0,0,0,0,17Z";

const PH_BICYCLE_FILL =
  "M54.46,164.71,82.33,126.5a48,48,0,1,1-12.92-9.44L41.54,155.29a8,8,0,1,0,12.92,9.42ZM208,112a47.81,47.81,0,0,0-16.93,3.09L214.91,156A8,8,0,1,1,201.09,164l-23.83-40.86A48,48,0,1,0,208,112ZM165.93,72H192a8,8,0,0,1,8,8,8,8,0,0,0,16,0,24,24,0,0,0-24-24H152a8,8,0,0,0-6.91,12l11.65,20H99.26L82.91,60A8,8,0,0,0,76,56H48a8,8,0,0,0,0,16H71.41L85.12,95.51,69.41,117.06a47.87,47.87,0,0,1,12.92,9.44l11.59-15.9L125.09,164A8,8,0,1,0,138.91,156l-30.32-52h57.48l11.19,19.17a48.11,48.11,0,0,1,13.81-8.08Z";

const BUS_SVG = `<svg viewBox="0 0 256 256" aria-hidden="true"><path d="${PH_BUS_FILL}"/></svg>`;
const BIKE_SVG = `<svg viewBox="0 0 256 256" aria-hidden="true"><path d="${PH_BICYCLE_FILL}"/></svg>`;
/* Phosphor has no trolleybus: its bus, scaled down, under two trolley poles */
const MODE_SVG: Record<TransitMode, string> = {
  bus: `<svg class="veh-mode" viewBox="0 0 256 256" aria-hidden="true"><path d="${PH_BUS_FILL}"/></svg>`,
  tram: `<svg class="veh-mode" viewBox="0 0 256 256" aria-hidden="true"><path d="${PH_TRAM_FILL}"/></svg>`,
  metro: `<svg class="veh-mode" viewBox="0 0 256 256" aria-hidden="true"><path d="${PH_SUBWAY_FILL}"/></svg>`,
  trolleybus:
    `<svg class="veh-mode" viewBox="0 0 256 256" aria-hidden="true"><path transform="translate(32 56) scale(0.75)" d="${PH_BUS_FILL}"/>` +
    `<path class="veh-poles" d="M108 80 76 16M148 80 116 16"/></svg>`,
};
const ARROW_SVG = `<svg viewBox="0 0 256 256" aria-hidden="true"><path transform="rotate(45 128 128)" d="${PH_NAV_ARROW_FILL}"/></svg>`;

/**
 * Vehicle pill icon: the operator logo, or a tram / metro / trolleybus glyph for those modes; `more` = how many
 * other vehicles the pill stands for (a stack whose pills would cover each other).
 * `bearing` only seeds the arrow's initial angle; after
 * that the VehicleAnimator rotates the arrow element in place. Never key an
 * icon memo on the heading: setIcon rewrites the DOM (replaying the pop
 * animation) on every turn.
 */
export function makeVehicleIcon(
  line: string,
  color: string,
  bearing: number | null,
  operator?: "KB" | "MZK" | "GZM",
  mode: TransitMode = "bus",
  scheduled = false,
  more = 0,
): L.DivIcon {
  const hasHeading = bearing != null;
  const arrow = hasHeading
    ? `<span class="veh-arrow" style="transform:rotate(${bearing}deg)">${ARROW_SVG}</span>`
    : "";
  // the pill draws the mark as a 13 px white silhouette: only marks made for that (app, MZK, GZM); most city logos
  // would be a blob, so the other zbiorkom cities get the bus glyph on their own colour
  const logo =
    operator === "MZK" ? "/mzk-logo.svg" : operator !== "GZM" ? "/brand.svg" : getPageCity() === "gzm" ? "/gzm-logo.svg" : null;
  const brandIcon =
    mode === "bus" && logo ? `<img class="veh-bus" src="${logo}" alt="" aria-hidden="true" draggable="false"/>` : MODE_SVG[mode];
  const opClass = operator === "GZM" ? " veh-gzm" : operator === "MZK" ? " veh-mzk" : "";

  return L.divIcon({
    className: `veh-marker${opClass}${scheduled ? " veh-sched" : ""}`,
    html:
      `<div class="veh-wrap"><div class="veh-pill${hasHeading ? "" : " no-heading"}" style="background:${color}">` +
      arrow +
      brandIcon +
      `<span class="veh-line">${escapeHtml(line || "?")}</span>` +
      (more ? `<span class="veh-more">+${more}</span>` : "") +
      `</div></div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

function stopOpClass(operator?: "KB" | "MZK" | "GZM" | "BOTH"): string {
  if (operator === "BOTH") return " is-both";
  if (operator === "MZK") return " is-mzk";
  return operator === "GZM" ? " is-gzm" : " is-kb";
}

/** Direction caret, cropped to the glyph so it sits flush against the stop disc. */
const STOP_ARROW_SVG = `<svg class="stop-arrow-svg" viewBox="32 60 192 116" aria-hidden="true"><path d="${PH_CARET_UP_FILL}"/></svg>`;

/**
 * Bus-stop marker, legible on both the light and the dark base map.
 * - Regular stops: an operator-coloured disc with a bus glyph and one caret
 *   per road direction, rotated about the disc centre.
 * - Bus stations (D.A.): a larger rounded square, no carets (multi-directional hub).
 */
export function makeStopIcon(
  dirs: number[] = [],
  isStation = false,
  operator?: "KB" | "MZK" | "GZM" | "BOTH",
): L.DivIcon {
  const opClass = stopOpClass(operator);
  const stnTitle =
    operator === "BOTH"
      ? "Komunikacja Beskidzka / MZK"
      : operator === "MZK"
        ? "MZK Bielsko-Biała"
        : operator === "GZM"
          ? CITY[getPageCity()].name
          : "Dworzec Autobusowy";
  if (isStation) {
    return L.divIcon({
      className: `stop-mk-icon${opClass}`,
      html: `<div class="stop-mk is-station${opClass}"><span class="stop-mk-sign stop-mk-station" title="${stnTitle}">${BUS_SVG}</span></div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  const arrows = dirs
    .map(
      (d) =>
        `<span class="stop-dir" style="transform:rotate(${d}deg)"><span class="stop-dir-ptr">${STOP_ARROW_SVG}</span></span>`,
    )
    .join("");

  return L.divIcon({
    className: `stop-mk-icon${opClass}`,
    html: `<div class="stop-mk${opClass}">${arrows}<span class="stop-mk-sign">${BUS_SVG}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

export function makeStopPingIcon(operator?: "KB" | "MZK" | "GZM" | "BOTH"): L.DivIcon {
  const opClass = stopOpClass(operator);
  return L.divIcon({
    className: `stop-ping-marker${opClass}`,
    html: '<div class="stop-ping"><span class="ring"></span><span class="core"></span></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

/** "You are here" dot — a pulsing blue GPS marker, distinct from brand red. */
export function makeUserLocationIcon(): L.DivIcon {
  return L.divIcon({
    className: "user-loc-marker",
    // the heading cone is turned in place by MapApp, never by a new icon
    html: '<span class="user-loc"><span class="user-loc-pulse"></span><span class="user-loc-head" hidden></span><span class="user-loc-dot"></span></span>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

/** Pin markers for a connection journey (start, transfer points, end). */
export function makeJourneyPinIcon(type: "start" | "transfer" | "walk" | "end", text?: string): L.DivIcon {
  if (type === "transfer" || type === "walk") {
    const badgeText = text ? `<span class="journey-trans-text">${escapeHtml(text)}</span>` : "";
    const path = type === "walk" ? PH_PERSON_WALK_BOLD : PH_ARROWS_LEFT_RIGHT_BOLD;
    const transferSvg = `<svg class="journey-trans-icon" viewBox="0 0 256 256" aria-hidden="true"><path d="${path}"/></svg>`;
    return L.divIcon({
      className: "journey-pin-marker",
      html: `<div class="journey-pin-wrap"><div class="journey-trans-pill">${transferSvg}${badgeText}</div></div>`,
      iconSize: [40, 24],
      iconAnchor: [20, 12],
    });
  }

  const isStart = type === "start";
  return L.divIcon({
    className: "journey-pin-marker",
    html: `<div class="journey-pin-wrap"><div class="journey-node-pin ${isStart ? "journey-node-start" : "journey-node-end"}"><span class="journey-node-inner"></span></div></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/** Metrorower station pill: bike glyph + available count (BikesLayer updates the count in place). */
export function makeBikeIcon(bikes: number): L.DivIcon {
  return L.divIcon({
    className: "bike-mk-icon",
    html: `<div class="bike-mk${bikes ? "" : " is-empty"}">${BIKE_SVG}<span class="bike-mk-n">${bikes}</span></div>`,
    iconSize: [36, 20],
    iconAnchor: [18, 10],
  });
}
