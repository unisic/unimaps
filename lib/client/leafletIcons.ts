/**
 * Leaflet divIcon factories: the vehicle pill (rotating heading arrow, operator
 * logo and line number on the operator colour), stop / station markers, the selected-stop
 * ping, the user location dot and the journey pins.
 * CLIENT-ONLY: imports leaflet, must only be reached from ssr:false trees.
 */
import L from "leaflet";

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
const PH_CARET_UP_FILL =
  "M215.39,163.06A8,8,0,0,1,208,168H48a8,8,0,0,1-5.66-13.66l80-80a8,8,0,0,1,11.32,0l80,80A8,8,0,0,1,215.39,163.06Z";
const PH_PERSON_WALK_BOLD =
  "M152,84a36,36,0,1,0-36-36A36,36,0,0,0,152,84Zm0-48a12,12,0,1,1-12,12A12,12,0,0,1,152,36Zm68,112a12,12,0,0,1-12,12c-37,0-55.27-18.47-70-33.3-1.71-1.72-3.36-3.4-5-5l-8.63,19.85L159,166.23a12,12,0,0,1,5,9.77v56a12,12,0,0,1-24,0V182.17l-25.37-18.12L83,236.78a12,12,0,1,1-22-9.57l50.06-115.13q-10.64.75-25,8.4a159.78,159.78,0,0,0-29.83,21.23,12,12,0,0,1-16.43-17.5c2.61-2.45,64.36-59.67,104.09-25.18,3.94,3.42,7.64,7.16,11.22,10.78C168.43,123.28,181,136,208,136A12,12,0,0,1,220,148Z";
const PH_ARROWS_LEFT_RIGHT_BOLD =
  "M216.49,184.49l-32,32a12,12,0,0,1-17-17L179,188H48a12,12,0,0,1,0-24H179l-11.52-11.51a12,12,0,0,1,17-17l32,32A12,12,0,0,1,216.49,184.49Zm-145-64a12,12,0,0,0,17-17L77,92H208a12,12,0,0,0,0-24H77L88.49,56.49a12,12,0,0,0-17-17l-32,32a12,12,0,0,0,0,17Z";

const BUS_SVG = `<svg viewBox="0 0 256 256" aria-hidden="true"><path d="${PH_BUS_FILL}"/></svg>`;
const ARROW_SVG = `<svg viewBox="0 0 256 256" aria-hidden="true"><path transform="rotate(45 128 128)" d="${PH_NAV_ARROW_FILL}"/></svg>`;

/**
 * Vehicle pill icon. `bearing` only seeds the arrow's initial angle — after
 * that the VehicleAnimator rotates the arrow element in place. Never key an
 * icon memo on the heading: setIcon rewrites the DOM (replaying the pop
 * animation) on every turn.
 */
export function makeVehicleIcon(
  line: string,
  color: string,
  bearing: number | null,
  operator?: "KB" | "MZK" | "GZM",
): L.DivIcon {
  const hasHeading = bearing != null;
  const arrow = hasHeading
    ? `<span class="veh-arrow" style="transform:rotate(${bearing}deg)">${ARROW_SVG}</span>`
    : "";
  const logo = operator === "GZM" ? "/gzm-logo.svg" : operator === "MZK" ? "/mzk-logo.svg" : "/brand.svg";
  const brandIcon = `<img class="veh-bus" src="${logo}" alt="" aria-hidden="true" draggable="false"/>`;
  const opClass = operator === "GZM" ? " veh-gzm" : operator === "MZK" ? " veh-mzk" : "";

  return L.divIcon({
    className: `veh-marker${opClass}`,
    html:
      `<div class="veh-wrap"><div class="veh-pill${hasHeading ? "" : " no-heading"}" style="background:${color}">` +
      arrow +
      brandIcon +
      `<span class="veh-line">${escapeHtml(line || "?")}</span></div></div>`,
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
          ? "Metropolia GZM"
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
    html: '<span class="user-loc"><span class="user-loc-pulse"></span><span class="user-loc-dot"></span></span>',
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
