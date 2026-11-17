import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { announceKey, stopToAnnounce } from "../lib/shared/announce";

describe("announceKey", () => {
  it("drops the post number and folds the name to [a-z0-9]", () => {
    assert.equal(announceKey("Katowice Plac Wolności 1"), "katowiceplacwolnosci");
    assert.equal(announceKey("Pszczelnik Stara Szosa 02"), "pszczelnikstaraszosa");
    assert.equal(announceKey("Kobiór PKP"), "kobiorpkp");
    assert.equal(announceKey("Łaziska Górne"), "laziskagorne");
  });

  it("matches the recordings' file names, composed or decomposed", () => {
    assert.equal(announceKey("Katowice_PlacWolnosci"), "katowiceplacwolnosci");
    assert.equal(announceKey("Kobio\u0301r_PKP"), "kobiorpkp");
  });

  it("is empty for a name with nothing to say and at most 94 characters", () => {
    assert.equal(announceKey(""), "");
    assert.equal(announceKey("ŻŹ ".repeat(80)).length, 94);
  });
});

describe("stopToAnnounce", () => {
  const none = { next: -1, name: -1 };

  it("says the next stop on leaving the previous one, then repeats its name when near, once each", () => {
    const left = { next: 3, name: 3 };
    assert.equal(stopToAnnounce(left, 4, false, false), "next");
    const said = { next: 4, name: 3 };
    assert.equal(stopToAnnounce(said, 4, false, false), null);
    assert.equal(stopToAnnounce(said, 4, false, true), "name");
    assert.equal(stopToAnnounce(said, 4, true, true), "name");
    const repeated = { next: 4, name: 4 };
    assert.equal(stopToAnnounce(repeated, 4, false, true), null);
    assert.equal(stopToAnnounce(repeated, 4, true, true), null);
  });

  it("applies the rule at once when the switch is turned on", () => {
    assert.equal(stopToAnnounce(none, 4, false, false), "next");
    assert.equal(stopToAnnounce(none, 4, true, true), "name");
  });

  it("says nothing new while the vehicle still stands at the previous stop", () => {
    assert.equal(stopToAnnounce({ next: 3, name: 3 }, 3, true, true), null);
  });

  it("never goes back to a stop behind the last announcement", () => {
    assert.equal(stopToAnnounce({ next: 5, name: 5 }, 4, false, true), null);
  });
});
