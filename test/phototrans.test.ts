import assert from "node:assert/strict";
import { test } from "node:test";

import { fuelOf, lengthOf, parseGroupPage, parseOperatorPage, parseVehiclePage, ptKey } from "../lib/phototrans";

// fragments captured from phototrans.eu on 2026-11-03 (operator 69 = PKM Katowice)
const OPERATOR = `<h4>Current fleet<h4><h5>Bus</h5> <table id="t1"><tbody>
<tr><td><a href="2415,69,17614,0.html">1200-1204</a> </td><td><a href="2415,69,17614,0.html">MAN NG323 Lion\`s City G</a></td><td class="big_display"><a href="autobusy.php?s=5015&marka_id=4&operator=69&r=SE">MAN</a></td><td class="big_display"><a href="x">MAN Lion\`s City</a></td><td class="big_display"><a href="y">MAN NGxx3 (A23/A24)</a></td><td class="big_display">MAN D2066LUH58 (Euro 6c)</td><td class="big_display"></td><td class="big_display">2017</td><td class="big_display"><b>-</b></td><td></td><td class="big_display">5/5</td></tr>
</tbody></table><h5>Truck</h5><table><tbody>
<tr><td><a href="2415,69,99,0.html">S1</a> </td><td>Star 266</td><td>Star</td><td></td><td></td><td></td><td></td><td>1990</td><td>-</td></tr>
</tbody></table><h4>Historic Fleet<h4><h5>Bus</h5><table><tbody>
<tr><td><a href="2415,69,5,0.html">100</a> </td><td>Ikarus 280</td><td>Ikarus</td><td></td><td></td><td></td><td></td><td>1980</td><td>2001</td></tr>
</tbody></table>`;

const GROUP = `<tr><td class="gensmall">Design of doors</td><td class="gensmall" style="font-weight: bold">1-2-2, 2-2-0, 2-2-2</td></tr><tr><td class="gensmall">No. of modules</td><td class="gensmall" style="font-weight: bold">1</td></tr></table>
<tr><td class=row_service rowspan=2><span class=genmed><b>0410<br /></b></span></td><td class=row_service><span class=gen><b>Solaris Urbino 12 electric</b></span></td></tr><tr><td colspan="8" class="row_service" style="text-align: right"><a class=nav href="15,882543,69.html">Show Photos and History Of Vehicle (2/0)</a></td></tr>
<tr><td class=row_spisan rowspan=2><span class=genmed><b>0410<br /></b></span></td><td class=row_spisan><span class=gen><b>Jelcz M11</b></span></td></tr><tr><td colspan="8" class="row_spisan" style="text-align: right"><a class=nav href="15,13400,45.html">Show Photos and History Of Vehicle (20/0)</a></td></tr>
<tr><td class=row_service rowspan=2><span class=genmed><b><br /></b></span></td><td class=row_service><span class=gen><b>Solaris Urbino 12 electric</b></span></td></tr><tr><td colspan="8" class="row_service" style="text-align: right"><a class=nav href="15,882545,69.html">Show Photos and History Of Vehicle (1/0)</a></td></tr>
<tr><td class=row_service rowspan=2><span class=genmed><b>SK 1234<br /></b></span></td><td class=row_service></td></tr><tr><td colspan="8"><a class=nav href="15,882544,69.html">Show Photos and History Of Vehicle (0/0)</a></td></tr>`;

const VEHICLE = `<tr><td class="row2" colspan="2"><span class="genmed">Built</span></td><td class="row2"><span class="genmed">2014</span></td></tr>
<div class=rowtable><div class=rowimage><a href="14,1406715,0,Solaris_Urbino_12_202.html"><img src="/images/photos/thumbnail/591/1406715.jpg?0" border=1  /></a></div><div class=rowopis><span class=genmed><b>28 october 2026</b> - <span class=genmed>Droga</span><br />Author: <a href="16,1798,0.html">Tomek94</a></span></div></div>
<div class=rowtable><div class=rowimage><a href="14,1406714,0,x.html"><img src="/images/photos/thumbnail/590/1406714.jpg?0" border=1  /></a></div><div class=rowopis><span class=genmed><b>3 may 2025</b><br />Author: <a href="16,7,0.html">J&#243;zef</a></span></div></div>`;

test("operator page: current passenger fleet only", () => {
  assert.deepEqual(parseOperatorPage(OPERATOR), [
    {
      id: 17614,
      kind: "Bus",
      model: "MAN NG323 Lion`s City G",
      producer: "MAN",
      body: "MAN Lion`s City",
      engine: "MAN D2066LUH58 (Euro 6c)",
      gearbox: "",
      since: 2017,
      active: 5,
    },
  ]);
});

test("group page: numbered vehicles in service, a withdrawn one (row_spisan) skipped, an unnumbered one only counted", () => {
  assert.deepEqual(parseGroupPage(GROUP), {
    doors: "1-2-2, 2-2-0, 2-2-2",
    modules: 1,
    vehicles: [
      { number: "0410", id: 882543, photos: 2 },
      { number: "SK 1234", id: 882544, photos: 0 },
    ],
    inService: 3,
  });
});

test("vehicle page: built year and newest photos, capped", () => {
  assert.deepEqual(parseVehiclePage(VEHICLE, 5), {
    built: 2014,
    photos: [
      ["591/1406715", "Tomek94", "2026-10-28"],
      ["590/1406714", "Józef", "2025-05-03"],
    ],
  });
  assert.equal(parseVehiclePage(VEHICLE, 1).photos.length, 1);
});

test("key drops leading zeros of the fleet number", () => {
  assert.equal(ptKey("gzm", "108_0410"), "gzm:108_410");
  assert.equal(ptKey("gzm", "108_410"), "gzm:108_410");
  assert.equal(ptKey("bb", "007"), "bb:7");
  assert.equal(ptKey("gzm", "2_0"), "gzm:2_0");
});

test("length and propulsion from the model", () => {
  assert.equal(lengthOf("Solaris Urbino 12 electric", 1, "Bus"), "MAXI");
  assert.equal(lengthOf("Volvo 7900 Hybrid 12,1m", null, "Bus"), "MAXI");
  assert.equal(lengthOf("Solaris Urbino 9 LE electric", null, "Bus"), "MINI");
  assert.equal(lengthOf("MAN NG323 Lion`s City G", 2, "Bus"), "MEGA");
  assert.equal(lengthOf("Irizar ie bus 18.73", null, "Bus"), "MEGA");
  assert.equal(lengthOf("Ikarus 280.70E", null, "Bus"), null);
  assert.equal(lengthOf("Pesa Twist 2012N", 3, "Tram"), null);

  assert.equal(fuelOf("Solaris Urbino 12 CNG", "FPT Cursor 8", "Bus"), "cng");
  assert.equal(fuelOf("Neso Bus 12 (H2)", "", "Bus"), "hydrogen");
  assert.equal(fuelOf("Solaris Urbino 18 mild hybrid", "Cummins", "Bus"), "hybrid");
  assert.equal(fuelOf("Karsan e-Atak", "", "Bus"), "electric");
  assert.equal(fuelOf("Mercedes-Benz eCitaro", "", "Bus"), "electric");
  assert.equal(fuelOf("Irizar ie bus 12.16", "", "Bus"), "electric");
  assert.equal(fuelOf("Konstal 105Na", "Dolmel LTa-220", "Tram"), "electric");
  assert.equal(fuelOf("Solaris Urbino 12", "Cummins ISB6.7E6 280B", "Bus"), "diesel");
  assert.equal(fuelOf("Ford Transit V", "", "Bus"), null);
});
