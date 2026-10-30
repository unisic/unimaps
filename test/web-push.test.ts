import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { encryptPayload, isPushSub, vapidAuth, vapidKeys } from "../lib/web-push";

const b = (s: string) => Buffer.from(s.replace(/\s/g, ""), "base64url");

describe("encryptPayload", () => {
  it("matches RFC 8291 section 5 byte for byte", () => {
    const out = encryptPayload(
      b("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      b("BTBZMqHH6r4Tts7J_aSIgg"),
      Buffer.from("When I grow up, I want to be a watermelon"),
      { asPrivate: b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt: b("DGv6ra1nlYgDCS1FRnbzlw") },
    );
    assert.equal(
      out.toString("base64url"),
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
        "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
        "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });
});

describe("vapid", () => {
  it("makes the pair once, keeps it, and signs an ES256 JWT for the endpoint's origin", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-"));
    const k = vapidKeys(dir);
    assert.equal(Buffer.from(k.pub, "base64url").length, 65);
    assert.ok(fs.existsSync(path.join(dir, "vapid.json")));
    const auth = vapidAuth("https://fcm.googleapis.com/fcm/send/abc", k, 1_800_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth);
    assert.ok(m);
    const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
    assert.equal(claims.aud, "https://fcm.googleapis.com");
    assert.equal(claims.exp, 1_800_000_000 + 12 * 3600);
    const pub = crypto.createPublicKey(k.key);
    const ok = crypto.verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url"));
    assert.equal(ok, true);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("isPushSub", () => {
  const keys = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
  it("accepts the push services only, with a real P-256 key", () => {
    assert.equal(isPushSub({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys }), true);
    assert.equal(isPushSub({ endpoint: "https://web.push.apple.com/Q", keys }), true);
    assert.equal(isPushSub({ endpoint: "https://wns2-par02p.notify.windows.com/w/?token=1", keys }), true);
    assert.equal(isPushSub({ endpoint: "http://fcm.googleapis.com/x", keys }), false);
    assert.equal(isPushSub({ endpoint: "https://127.0.0.1/x", keys }), false);
    assert.equal(isPushSub({ endpoint: "https://evilfcm.googleapis.com.example/x", keys }), false);
    assert.equal(isPushSub({ endpoint: "https://fcm.googleapis.com:8443/x", keys }), false);
    assert.equal(isPushSub({ endpoint: "https://fcm.googleapis.com/x", keys: { ...keys, p256dh: "AAAA" } }), false);
    assert.equal(isPushSub({ endpoint: "https://fcm.googleapis.com/x", keys: { ...keys, auth: "AAAA" } }), false);
  });
});
