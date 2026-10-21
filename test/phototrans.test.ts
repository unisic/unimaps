import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findVehiclePhotos, parsePhotos, pickVehicle } from "../lib/phototrans";

// fragments of real phototrans.eu pages (2026-10-15)
const row = (id: number, cells: string[]) =>
  `<tr><td><a href="15,${id},0.html">Mercedes-Benz O530 II A30</a></td>${cells.map((c) => `<td>${c}</td>`).join("")}<td>${id}</th></tr>`;
const ROW_126 = row(184321, ["WEB62809013700774", "", "2008", "2008", "No", "No", "SB 5126C", "126", "", "MZK Bielsko-Biała", ""]);

const VEHICLE_PAGE =
  '<h3>Photos</h3><div style="display: block;" class=rowtable><div class=rowimage><a href="14,1318658,0,Mercedes_Benz_O530_II_A30_126.html"><img src="/images/photos/thumbnail/206/1318658.jpg" border=1  /></a></div><div class=rowopis><span class=genmed><b>1 february 2025</b> - <span class=genmed name=opis-1318658 id=opis-1318658>Bielsko-Biała, ul. Wałowa.</span><br />Author: <a href="16,1943,0.html">Macboja</a></span> <br /></div></div>' +
  '<div style="display: block;" class=rowtable><div class=rowimage><a href="14,1266504,0,Mercedes_Benz_O530_II_A30_126.html"><img src="/images/photos/thumbnail/318/1266504.jpg" border=1  /></a></div><div class=rowopis><span class=genmed><b>22 march 2023</b><br />Author: <a href="16,7,0.html">Other</a></span></div></div>';

describe("pickVehicle", () => {
  it("finds the vehicle page by exact side number", () => {
    assert.equal(pickVehicle(`<table><tbody>${ROW_126}</tbody></table>`, "126"), 184321);
    assert.equal(pickVehicle(`<table><tbody>${ROW_126}</tbody></table>`, "12"), null);
    assert.equal(pickVehicle("<p>Found 0</p>", "999"), null);
  });

  it("prefers the bus still in service when a number was reused", () => {
    const old = row(1000, ["X", "", "1995", "1996", "2012", "Yes", "BB 12345", "126", "", "MZK Bielsko-Biała", ""]);
    assert.equal(pickVehicle(old + ROW_126, "126"), 184321);
    assert.equal(pickVehicle(ROW_126 + old, "126"), 184321);
  });
});

describe("parsePhotos", () => {
  const newest = {
    thumb: "https://phototrans.eu/images/photos/thumbnail/206/1318658.jpg",
    page: "https://phototrans.eu/14,1318658,0,Mercedes_Benz_O530_II_A30_126.html",
    author: "Macboja",
    authorPage: "https://phototrans.eu/16,1943,0.html",
    date: "2025-02-01",
  };

  it("returns the photos newest first, each with its author", () => {
    const photos = parsePhotos(VEHICLE_PAGE);
    assert.deepEqual(photos[0], newest);
    assert.deepEqual(
      photos.map((p) => [p.author, p.date]),
      [
        ["Macboja", "2025-02-01"],
        ["Other", "2023-03-22"],
      ],
    );
  });

  it("keeps at most `max`", () => {
    assert.deepEqual(parsePhotos(VEHICLE_PAGE, 1), [newest]);
  });

  it("is empty for a vehicle without photos", () => {
    assert.deepEqual(parsePhotos("<h3>Photos</h3><p>No photos</p>"), []);
  });
});

describe("findVehiclePhotos", () => {
  it("stops asking phototrans once it answers 403", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response("blocked", { status: 403 });
    });
    await assert.rejects(findVehiclePhotos("126"), /HTTP 403/);
    await assert.rejects(findVehiclePhotos("127"), /backing off/);
    assert.equal(calls, 1);
  });
});
