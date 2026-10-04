import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import manifestFn from "../app/manifest";

/*
 * Source-level guards for the /brygady page: things that only show on a real phone (notch, home
 * indicator, Android back) or to a screen reader, and are easy to lose in a refactor.
 */
const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf-8");

describe("Brygady section: PWA & mobile UX", () => {
  const app = read("components/BrigadesApp.tsx");
  const sheet = read("components/brygady/VehicleSheet.tsx");
  const list = read("components/brygady/FleetList.tsx");
  const charts = read("components/brygady/charts.tsx");
  const manifest = manifestFn();

  it("has a home-screen shortcut", () => {
    const shortcut = (manifest.shortcuts ?? []).find((s) => s.url === "/brygady");
    assert.ok(shortcut, "manifest must define a shortcut with url: /brygady");
    assert.equal(shortcut.name, "Brygady i Tabor");
    assert.equal(shortcut.short_name, "Brygady");
    assert.ok(shortcut.icons && shortcut.icons.length > 0, "shortcut must provide an icon");
  });

  it("clears the notch and the home indicator", () => {
    assert.match(app, /sticky top-0[^"]*pt-\[env\(safe-area-inset-top\)\]/, "sticky header below the status bar");
    assert.match(app, /pb-\[max\([^)]*env\(safe-area-inset-bottom\)\)\]/, "page bottom clears the home indicator");
    assert.match(app, /fixed bottom-\[max\([^)]*env\(safe-area-inset-bottom\)\)\]/, "floating button clears it too");
    assert.match(sheet, /pb-\[max\([^)]*env\(safe-area-inset-bottom\)\)\]/, "sheet body: last rows above the gesture bar");
  });

  it("vehicle card is a modal dialog: bottom sheet on phones, centred on desktop", () => {
    assert.ok(sheet.includes('role="dialog"') && sheet.includes('aria-modal="true"') && sheet.includes("aria-labelledby"));
    assert.ok(sheet.includes("items-end") && sheet.includes("md:items-center"));
    assert.match(sheet, /max-h-\[\d+dvh\]/, "dynamic viewport units respect mobile URL bars");
    assert.ok(sheet.includes('e.key === "Escape"'), "Escape closes");
    assert.ok(sheet.includes('e.key !== "Tab"') || sheet.includes('e.key === "Tab"'), "focus is trapped");
    assert.ok(sheet.includes("overflow = \"hidden\""), "page behind does not scroll");
    assert.match(app, /inert=\{inert\}/, "page behind the sheet is inert");
  });

  it("Android back closes the vehicle card, a deep-linked card closes without leaving the page", () => {
    assert.ok(app.includes("window.history.pushState({ kbTabor: true }"));
    assert.ok(app.includes("window.history.back()"));
    assert.match(app, /if \(sheetEntry\(\)\) window\.history\.back\(\);\s*else window\.history\.replaceState/);
    assert.ok(!/router\.(push|replace|back)/.test(app), "plain History API, never the Next router");
  });

  it("shares a vehicle with the native share sheet (clipboard fallback lives in ShareButton)", () => {
    assert.ok(sheet.includes("<ShareButton"));
    const ui = read("components/ui.tsx");
    assert.ok(ui.includes("navigator.share") && ui.includes("navigator.clipboard.writeText"));
  });

  it("keeps controls accessible: real buttons, labelled search, ARIA tabs and disclosures", () => {
    assert.ok(list.includes('type="search"') && list.includes('className="sr-only"'), "labelled search field");
    assert.ok(app.includes('role="tablist"') && app.includes('role="tab"') && app.includes("aria-selected"));
    assert.ok(sheet.includes("aria-expanded={open}") && sheet.includes("aria-controls={panelId}"));
    assert.ok(sheet.includes('role="progressbar"'));
    assert.ok(charts.includes("<title") || charts.includes("aria-label"), "charts carry an accessible name");
    // the sheet backdrop is the one exception: aria-hidden, Escape and the close button cover it
    assert.ok(!/<div(?![^>]*aria-hidden)[^>]*onClick=/.test(app + sheet + list), "clickable divs: use <button>");
  });

  it("uses no emoji as icons and no em dash in UI copy", () => {
    for (const [name, src] of [
      ["BrigadesApp", app],
      ["VehicleSheet", sheet],
      ["FleetList", list],
      ["charts", charts],
      ["FleetStatsView", read("components/brygady/FleetStatsView.tsx")],
    ] as const) {
      assert.ok(!/\p{Extended_Pictographic}/u.test(src), `${name}: emoji found`);
      const copy = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      assert.ok(!copy.includes("—"), `${name}: em dash in UI copy`);
    }
  });
});
