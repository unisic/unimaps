/**
 * Leaflet divIcon factories: the zbiorkom-style vehicle pill (rotating heading
 * arrow + the KB brand bus mark + line number, all on the line/status color)
 * and the pulsing selected-stop marker.
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

/** Navigation arrow, points up (north) at 0°; CSS rotate matches compass bearing. */
const ARROW_PATH = "M12 5 18 19 12 16 6 19Z";

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
  operator?: "KB" | "MZK",
): L.DivIcon {
  const hasHeading = bearing != null;
  const arrow = hasHeading
    ? `<span class="veh-arrow" style="transform:rotate(${bearing}deg)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ARROW_PATH}"/></svg></span>`
    : "";
  const isMzk = operator === "MZK";
  const brandIcon = isMzk
    ? `<img class="veh-bus veh-mzk-logo" src="/mzk-logo.svg" alt="MZK" aria-hidden="true" draggable="false"/>`
    : `<img class="veh-bus" src="/brand.svg" alt="KB" aria-hidden="true" draggable="false"/>`;

  return L.divIcon({
    className: `veh-marker${isMzk ? " veh-mzk" : ""}`,
    html:
      `<div class="veh-wrap"><div class="veh-pill${hasHeading ? "" : " no-heading"}${isMzk ? " is-mzk" : ""}" style="background:${color}">` +
      arrow +
      brandIcon +
      `<span class="veh-line">${escapeHtml(line || "?")}</span></div></div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

/** Bus stop glyph — clean transit bus symbol in a rounded badge. */
const STOP_BUS_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="4" y="4" width="16" height="12" rx="2.5"/>' +
  '<path d="M4 10h16M8 4v6M16 4v6"/>' +
  '<circle cx="7.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/>' +
  '<circle cx="16.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/></svg>';

/** Bus station (D.A.) glyph — terminal hub building icon. */
const STATION_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 21h18M5 21V8l7-4 7 4v13"/>' +
  '<path d="M9 13h6M9 17h6"/>' +
  '<circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none"/></svg>';

/** Road direction arrow — crisp navigation chevron flush against the stop disc rim. */
const STOP_ARROW_SVG =
  '<svg class="stop-arrow-svg" viewBox="0 0 12 8" aria-hidden="true">' +
  '<path d="M6 1 L10.5 7 L6 5.5 L1.5 7 Z" fill="currentColor"/>' +
  '</svg>';

/**
 * Modern bus-stop marker designed for both dark and light map styles.
 * - Regular stops: a sleek circular disc (dark surface + crisp white border)
 *   with one or two route-tangent arrows pointing along the road direction.
 * - Bus stations (D.A.): distinctive brand-red hub badge with terminal glyph
 *   and NO directional arrows (multi-directional hub).
 */
export function makeStopIcon(
  dirs: number[] = [],
  isStation = false,
  operator?: "KB" | "MZK" | "BOTH",
): L.DivIcon {
  const opClass = operator === "BOTH" ? " is-both" : operator === "MZK" ? " is-mzk" : " is-kb";
  const stnTitle =
    operator === "BOTH"
      ? "Komunikacja Beskidzka / MZK"
      : operator === "MZK"
        ? "MZK Bielsko-Biała"
        : "Dworzec Autobusowy";
  if (isStation) {
    return L.divIcon({
      className: `stop-mk-icon${opClass}`,
      html: `<div class="stop-mk is-station${opClass}"><span class="stop-mk-sign stop-mk-station" title="${stnTitle}">${STATION_SVG}</span></div>`,
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
    html: `<div class="stop-mk${opClass}">${arrows}<span class="stop-mk-sign">${STOP_BUS_SVG}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

export function makeStopPingIcon(operator?: "KB" | "MZK" | "BOTH"): L.DivIcon {
  const opClass = operator === "BOTH" ? " is-both" : operator === "MZK" ? " is-mzk" : " is-kb";
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

/** Prominent pin markers for connection journey (start, transfer points, end). */
export function makeJourneyPinIcon(type: "start" | "transfer" | "end", text?: string): L.DivIcon {
  if (type === "transfer") {
    const badgeText = text ? `<span class="journey-trans-text">${escapeHtml(text)}</span>` : "";
    const transferSvg =
      '<svg class="journey-trans-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/>' +
      "</svg>";
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
