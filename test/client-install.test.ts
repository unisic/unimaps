import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installKind } from "../lib/client/install";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

describe("installKind", () => {
  it("offers nothing inside an installed app", () => {
    assert.equal(installKind(IPHONE, true, false), null);
    assert.equal(installKind(ANDROID, true, true), null);
  });

  it("prefers the native prompt whenever the browser deferred one", () => {
    assert.equal(installKind(ANDROID, false, true), "prompt");
  });

  it("shows the Share-sheet steps on iPhone and on an iPad posing as a Mac", () => {
    assert.equal(installKind(IPHONE, false, false), "ios");
    assert.equal(installKind(IPAD_AS_MAC, false, false, 5), "ios");
    assert.equal(installKind(IPAD_AS_MAC, false, false, 0), null);
  });

  it("stays quiet on a desktop browser without a prompt", () => {
    assert.equal(installKind(ANDROID, false, false), null);
  });
});
